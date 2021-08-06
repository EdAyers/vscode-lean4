import React from "react"
import { DocumentUri, TextDocumentPositionParams } from "vscode-languageserver-protocol"
import { RpcPtr } from "../lspTypes"
import { EditorContext, RpcContext } from "./contexts"
import { EditorConnection } from "./editorConnection"
import { DocumentPosition, useServerNotificationEffect } from "./util"

interface RpcConnectParams {
    uri: DocumentUri
}

interface RpcConnected {
    uri: DocumentUri
    sessionId: string
}

interface RpcCallParams extends TextDocumentPositionParams {
    sessionId: string
    method: string
    params: any
}

interface RpcReleaseParams {
    uri: DocumentUri
    sessionId: string
    refs: RpcPtr<any>[]
}

const RpcNeedsReconnect = -32900

class RpcSession {
    #ec: EditorConnection
    #uri: DocumentUri
    /** A timeout mechanism for notifying the server about batches of GC'd refs in fewer messages. */
    #releaseTimeout?: number
    #refsToRelease: RpcPtr<any>[]
    #finalizers: FinalizationRegistry<RpcPtr<any>>

    constructor(readonly sessionId: string, uri: DocumentUri, ec: EditorConnection) {
        this.#ec = ec
        this.#uri = uri
        // Here we hook into the JS GC and send release-reference notifications
        // whenever the GC finalizes a number of `RpcPtr`s. Requires ES2021.
        this.#refsToRelease = []
        this.#finalizers = new FinalizationRegistry(ptr => {
            if (this.#releaseTimeout !== undefined) clearTimeout(this.#releaseTimeout)
            this.#refsToRelease.push(ptr)

            const sendReleaseNotif = () => {
                const params: RpcReleaseParams = {
                    uri: this.#uri,
                    sessionId: this.sessionId,
                    refs: this.#refsToRelease,
                }
                void this.#ec.api.sendClientNotification('$/lean/rpc/release', params)
                this.#releaseTimeout = undefined
                this.#refsToRelease = []
            }

            // We release eagerly instead of delaying when this many refs become garbage
            const maxBatchSize = 100
            if (this.#refsToRelease.length > maxBatchSize) {
                sendReleaseNotif()
            } else {
                this.#releaseTimeout = window.setTimeout(() => {
                    sendReleaseNotif()
                }, 100)
            }
        })
    }

    async call(pos: DocumentPosition, method: string, params: any): Promise<any> {
        const rpcParams: RpcCallParams = {
            ...DocumentPosition.toTdpp(pos),
            sessionId: this.sessionId,
            method: method,
            params: params,
        }
        const val = await this.#ec.api.sendClientRequest('$/lean/rpc/call', rpcParams)
        // const s = JSON.stringify(val)
        // console.log(`'${method}(${JSON.stringify(params)})' at '${pos.line}:${pos.character}' -> '${s.length < 200 ? s : '(..)'}'`)
        return val
    }

    registerRef(ptr: RpcPtr<any>) {
        this.#finalizers.register(ptr, RpcPtr.copy(ptr))
    }
}

/** Provides an interface for making RPC calls to the Lean server. */
export class RpcSessions {
    /** Maps each URI to the connected RPC session, if any, at the corresponding file worker. */
    #connected: Map<DocumentUri, RpcSession>
    /** Like `#connected`, but for sessions which are currently connecting. */
    #connecting: Map<DocumentUri, Promise<RpcSession>>
    #ec: EditorConnection
    setSelf: (_: (_: RpcSessions) => RpcSessions) => void

    constructor(ec: EditorConnection) {
        this.#connected = new Map()
        this.#connecting = new Map()
        this.#ec = ec
        this.setSelf = () => { }
    }

    private async sessionAt(uri: DocumentUri): Promise<RpcSession | undefined> {
        if (this.#connected.has(uri)) return this.#connected.get(uri)!
        else if (this.#connecting.has(uri)) return this.#connecting.get(uri)!
        else return undefined
    }

    private connectAt(uri: DocumentUri): void {
        // NOTE(WN): a request would be slightly simpler to handle than a notification,
        // but would complicate the server more.

        if (this.#connecting.has(uri)) {
            throw `already connecting at '${uri}'`
        }
        if (this.#connected.has(uri)) {
            this.#connected.delete(uri)
        }
        const newSesh = new Promise<RpcSession>(resolve => {
            const h = this.#ec.events.gotServerNotification.on(([method, params]) => {
                if (method !== '$/lean/rpc/connected') return
                const conn: RpcConnected = params
                if (conn.uri !== uri) return
                resolve(new RpcSession(params.sessionId, conn.uri, this.#ec))
                h.dispose() // this works, somehow
            })
        })
        this.#connecting.set(uri, newSesh)
        const connParams: RpcConnectParams = { uri }
        this.#ec.api.sendClientNotification('$/lean/rpc/connect', connParams)
        newSesh.then(newSesh => {
            this.#connected.set(uri, newSesh)
            this.#connecting.delete(uri)

            // Trigger a React update when we connect.
            this.setSelf(rs => {
                // The `RpcSessions` object is intentionally global with only a shallow copy here
                const newRs = new RpcSessions(rs.#ec)
                newRs.#connected = rs.#connected
                newRs.#connecting = rs.#connecting
                newRs.setSelf = rs.setSelf
                return newRs
            })
        })
    }

    /**
     * Executes an RPC call in the context of `pos`. If the relevant RPC session is not yet
     * connected, returns `undefined` and then triggers a React update. See also `registerRef`.
     */
    async call<T>(pos: DocumentPosition, method: string, params: any): Promise<T | undefined> {
        const sesh = await this.sessionAt(pos.uri)
        if (!sesh) {
            this.connectAt(pos.uri)
            return undefined
        }

        try {
            const ret = await sesh.call(pos, method, params)
            return ret
        } catch (ex) {
            if (ex.code === RpcNeedsReconnect) {
                // Are we reconnecting yet?
                if (!this.#connecting.has(pos.uri)) {
                    this.connectAt(pos.uri)
                }
                return undefined
            }
            console.error(`RPC error: ${JSON.stringify(ex)}`)
            throw ex
        }
    }

    /**
     * All {@link RpcPtr}s received from the server must be registered for garbage
     * collection through this method. Not doing so is safe but will leak memory.
     */
    registerRef(pos: DocumentPosition, ptr: RpcPtr<any>): void {
        void this.sessionAt(pos.uri).then(sesh => {
            if (sesh) sesh.registerRef(ptr)
            else throw `tried to register ref in non-existent RPC session ${pos.uri}`
        })
    }

    /**
     * Returns an identifier for the RPC session at `uri`. When this changes, all components
     * which may use RPC in the context of that document must be re-created to avoid using
     * outdated references.
     */
    sessionIdAt(uri: DocumentUri): string {
        if (this.#connected.has(uri)) return this.#connected.get(uri)!.sessionId
        return ''
    }
}

/** Manages a Lean RPC connection by providing an {@link RpcContext} to the children. */
export function WithRpcSessions({ children }: { children: React.ReactNode }) {
    const ec = React.useContext(EditorContext)
    const [sessions, setSessions] = React.useState<RpcSessions>(new RpcSessions(ec))
    sessions.setSelf = setSessions

    useServerNotificationEffect('$/lean/rpc/connected', _ => {
        // Just subscribe here, but actually handle internally
    }, [])

    return <RpcContext.Provider value={sessions}>
        {children}
    </RpcContext.Provider>
}

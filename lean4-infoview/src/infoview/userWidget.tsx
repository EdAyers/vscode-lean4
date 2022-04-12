import * as React from 'react';
import type { Location } from 'vscode-languageserver-protocol';

import { EditorContext, RpcContext } from './contexts';
import { Widget_getStaticJS, Widget_getWidget } from './rpcInterface';
import { DocumentPosition, useEvent, useEventResult } from './util';
import { ErrorBoundary } from './errors';
import { RpcSessions } from './rpcSessions';
import { isRpcError, RpcErrorCode } from '@lean4/infoview-api';

function memoize<T extends (...args : any[]) => any>(fn: T, keyFn: any = (x: any) => x) : T {
    const cache = new Map()
    const r : any = (...args: any[]) => {
        const key = keyFn(...args)
        if (!cache.has(key)) {
            const result = fn(...args)
            if (result) {
                cache.set(key, result)
            }
            return result
        }
        return cache.get(key)
    }
    return r
}

// [todo] cache should be invalidated when document changes.
const dynamicallyLoadComponent = memoize(function (widgetId : string, code: string, ) {
    return React.lazy(async () => {
        let file = new File([code], `widget_${widgetId}.js`, { type: "text/javascript" })
        let url = URL.createObjectURL(file)
        return await import(url)
    })
})

type Status = "pending" | "fulfilled" | "rejected"

// [todo] this badly handles case where effect is being spammed because lots of in-flight promises will be updating the state without locks.
// There is some code in the infoview that deals with this problem somewhere.
export function useAsync<T>(fn : () => Promise<T>, deps : React.DependencyList = []) : [Status, T | undefined, Error] {
    const [status, setStatus] = React.useState<Status>("pending")
    const [result, setResult] = React.useState<T | undefined>(undefined)
    const [error, setError] = React.useState<unknown | undefined>(undefined)
    React.useEffect(() => {
        setStatus("pending")
        fn().then(result => {
            setStatus("fulfilled")
            setResult(result)
            setError(undefined)
        }, (err : unknown) => {
            setStatus("rejected")
            if (isRpcError(err)) {
                err = new Error(`Rpc error: ${RpcErrorCode[err.code]}: ${err.message}`)
            } else if (! (err instanceof Error)) {
                err = new Error(`Unrecognised error ${JSON.stringify(err)}`)
            }
            setError(err)
        })
    }, deps)
    return [status, result, error]
}

interface GetWidgetResult {
    component? : any
    id : string
    props : any
}

async function getWidget(rc : RpcSessions, pos : DocumentPosition) : Promise<undefined | GetWidgetResult> {
    const widget = await Widget_getWidget(rc, pos)
    if (!widget) {
        return undefined
    }
    const code = await Widget_getStaticJS(rc, pos, widget.id)
    if (!code) {
        return widget
    }
    const component = dynamicallyLoadComponent(widget.id, code)
    return {...widget, component}
}

export function UserWidget(props: any) {
    const ec = React.useContext(EditorContext);
    const rs = React.useContext(RpcContext);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const curLoc = useEventResult<Location | undefined>(
        ec.events.changedCursorLocation,
        // @ts-ignore
        (loc, prev) => loc ?? prev
    )
    if (!curLoc) {
        return <>Waiting for a location.</>
    }
    const curPos: DocumentPosition = { uri: curLoc.uri, ...curLoc.range.start };
    const [status, result, error] = useAsync(() => getWidget(rs, curPos), [curPos.uri, curPos.line, curPos.character])


    const widgetId = result?.id
    const ps = result?.props
    const component = result?.component


    return <React.Suspense fallback={`Loading widget: ${widgetId} ${status}.`}>
        <ErrorBoundary>
            <div>{status}</div>
            {component && <div>{React.createElement(component, ps)}</div>}
            {error && <div>{error.message}</div>}
        </ErrorBoundary>
    </React.Suspense>
}

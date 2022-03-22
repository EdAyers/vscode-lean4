import * as React from 'react';
import type { Location } from 'vscode-languageserver-protocol';

import { EditorContext, RpcContext } from './contexts';
import { Widget_getCodeAtPoint } from './rpcInterface';
import { DocumentPosition, useEvent } from './util';
import { ErrorBoundary } from './errors';

export const RenderCode = (widgetCode: string) =>
    React.lazy(() => import(`data:text/javascript;base64,${btoa(widgetCode)}`))

export function UserWidget(props: any) {
    const ec = React.useContext(EditorContext);
    const rs = React.useContext(RpcContext);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [curLoc, setCurLoc] = React.useState<Location>(ec.events.changedCursorLocation.current!);
    useEvent(ec.events.changedCursorLocation, loc => loc && setCurLoc(loc), []);

    const curPos: DocumentPosition = { uri: curLoc.uri, ...curLoc.range.start };

    const [code, setCode] = React.useState<string | undefined>(undefined);
    const [error, setError] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        void Widget_getCodeAtPoint(rs, curPos)
            .then(code => {
                setCode(code)
                setError(undefined)
            })
            .catch(err => {
                setCode(undefined)
                setError(JSON.stringify(err))
            })
    }, [curPos.uri, curPos.line, curPos.character]);

    return <React.Suspense fallback="Loading widget..">
        <ErrorBoundary>
            {error && <>RPC Error: {error}</>}
            {code && React.createElement(RenderCode(code))}
        </ErrorBoundary>
    </React.Suspense>
}

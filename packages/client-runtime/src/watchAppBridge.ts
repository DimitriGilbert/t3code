// @effect-diagnostics globalTimers:off - The bridge runs in the client, outside an Effect runtime.
import type {
  WatchConnectorInstanceId,
  WatchWidgetBridgeManifest,
  WatchWidgetSourceRecord,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

/**
 * The host side of the agent-authored watch-widget bridge: JSON-RPC 2.0 over
 * postMessage between a client and one widget document, modeled on
 * `mcpApps/host.ts` and sharing its caps. It is transport-free so web (a
 * sandboxed srcdoc iframe) and mobile (a WebView over the identical document)
 * enforce the same contract; each platform supplies how to post a message and
 * how to start feeding subscription data.
 *
 * The bridge enforces the widget's declared manifest rather than trusting the
 * frame: undeclared subscriptions and actions are dropped and surfaced through
 * `onViolation` as widget errors. Data subscriptions are authorized against the
 * connector instance id resolved from the widget row's config — a
 * frame-supplied instance id is never trusted and any value other than the
 * widget's configured binding is a violation.
 */

const MAX_MESSAGE_BYTES = 256 * 1024;
/** Requests a widget may have in flight at once; more are refused, not queued. */
const MAX_PENDING_REQUESTS = 16;
const encoder = new TextEncoder();

export const WATCH_APP_METHODS = {
  subscribe: "t3.watch/subscribe",
  unsubscribe: "t3.watch/unsubscribe",
  action: "t3.watch/action",
  hostContext: "t3.watch/context",
} as const;

export const WATCH_APP_NOTIFICATIONS = {
  data: "t3.watch/data",
  dataError: "t3.watch/data-error",
  hostContext: "t3.watch/context",
} as const;

type JsonRpcId = string | number;

/** A bridge call the manifest does not permit, or one that escapes the widget's binding. */
export type WatchAppBridgeViolationCode =
  | "undeclaredSubscription"
  | "undeclaredAction"
  | "foreignInstance"
  | "navigatedAway";

export interface WatchAppBridgeViolation {
  readonly code: WatchAppBridgeViolationCode;
  readonly message: string;
  /** The subscription or action name the frame asked for. */
  readonly name?: string;
}

/** Thrown by host callbacks to refuse a request with a message the widget can show. */
export class WatchAppHostRefusal extends Error {}

/**
 * The platform side of the bridge. `openSubscription` resolves once the feed is
 * live; items then reach the document through `host.deliver(name, item)`.
 */
export interface WatchAppHostHandlers {
  readonly openSubscription: (input: {
    readonly name: string;
    /**
     * The connector instance resolved host-side from the widget row's config —
     * `undefined` for widgets with no connector binding. Never a frame-supplied id.
     */
    readonly instanceId: WatchConnectorInstanceId | undefined;
  }) => Promise<void>;
  readonly closeSubscription: (input: { readonly name: string }) => void;
  readonly invokeAction: (input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Every dropped manifest breach lands here so the widget shell can render it. */
  readonly onViolation: (violation: WatchAppBridgeViolation) => void;
  readonly hostContext?: () => Record<string, unknown>;
}

export interface WatchAppHostOptions extends WatchAppHostHandlers {
  readonly manifest: WatchWidgetBridgeManifest;
  /**
   * Read on every subscribe request: the connector instance the widget row
   * currently binds, so a live config change tightens the check immediately.
   */
  readonly connectorInstanceId: () => WatchConnectorInstanceId | undefined;
  /** Posts one JSON-RPC message to the widget document. */
  readonly post: (message: unknown) => void;
}

export interface WatchAppHost {
  /** Handles one message the widget posted; the caller has already checked its source. */
  readonly receive: (data: unknown) => void;
  /** Feeds an open subscription; posts `t3.watch/data` to the document. */
  readonly deliver: (name: string, item: unknown) => void;
  /** Reports a failed feed; posts `t3.watch/data-error` to the document. */
  readonly deliverError: (name: string, message: string) => void;
  /** Pushes the current host context as `t3.watch/context`. */
  readonly updateHostContext: () => void;
  /** Closes every open subscription and stops all posting. */
  readonly dispose: () => void;
}

function jsonBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.";

export function makeWatchAppHost(options: WatchAppHostOptions): WatchAppHost {
  let disposed = false;
  let pending = 0;
  /** Names with a live feed; opening and open names both count against the manifest. */
  const opening = new Set<string>();
  const open = new Set<string>();

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });

  const violate = (violation: WatchAppBridgeViolation) => {
    try {
      options.onViolation(violation);
    } catch {
      // A throwing error reporter must not take the bridge down.
    }
  };

  const answer = (id: JsonRpcId, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) {
      fail(id, -32000, "Too many requests in flight.");
      return;
    }
    pending += 1;
    void run().then(
      (result) => {
        pending -= 1;
        respond(id, result);
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, -32000, errorMessage(error));
      },
    );
  };

  const closeName = (name: string) => {
    if (open.delete(name)) options.closeSubscription({ name });
  };

  const handleSubscribe = (id: JsonRpcId, params: Record<PropertyKey, unknown>) => {
    const name = params.name;
    if (typeof name !== "string" || name.trim() === "") {
      fail(id, -32602, "t3.watch/subscribe needs a subscription name.");
      return;
    }
    if (!options.manifest.subscriptions.includes(name)) {
      violate({
        code: "undeclaredSubscription",
        name,
        message: `The widget bridge manifest does not declare a "${name}" subscription.`,
      });
      fail(id, -32000, `The "${name}" subscription is not declared by this widget.`);
      return;
    }
    const bound = options.connectorInstanceId();
    const requested = params.instanceId;
    // A frame-supplied instance id is never trusted: anything other than the
    // widget row's configured binding is a containment breach, not an argument.
    if (requested !== undefined && requested !== bound) {
      violate({
        code: "foreignInstance",
        name,
        message:
          bound === undefined
            ? `The widget asked for connector instance "${String(requested)}" but has no connector binding.`
            : `The widget asked for connector instance "${String(requested)}"; its binding is "${bound}".`,
      });
      fail(id, -32000, "The requested connector instance is not this widget's binding.");
      return;
    }
    if (open.has(name) || opening.has(name)) {
      respond(id, {});
      return;
    }
    opening.add(name);
    answer(id, () =>
      options.openSubscription({ name, instanceId: bound }).then(
        () => {
          opening.delete(name);
          if (disposed) {
            options.closeSubscription({ name });
            return {};
          }
          open.add(name);
          return {};
        },
        (error: unknown) => {
          opening.delete(name);
          throw error;
        },
      ),
    );
  };

  const handleRequest = (id: JsonRpcId, method: string, params: Record<PropertyKey, unknown>) => {
    switch (method) {
      case "ping":
        respond(id, {});
        return;
      case WATCH_APP_METHODS.hostContext:
        respond(id, options.hostContext?.() ?? {});
        return;
      case WATCH_APP_METHODS.subscribe:
        handleSubscribe(id, params);
        return;
      case WATCH_APP_METHODS.unsubscribe: {
        const name = params.name;
        if (typeof name !== "string" || name.trim() === "") {
          fail(id, -32602, "t3.watch/unsubscribe needs a subscription name.");
          return;
        }
        opening.delete(name);
        closeName(name);
        respond(id, {});
        return;
      }
      case WATCH_APP_METHODS.action: {
        const name = params.name;
        if (typeof name !== "string" || name.trim() === "") {
          fail(id, -32602, "t3.watch/action needs an action name.");
          return;
        }
        if (!options.manifest.actions.includes(name)) {
          violate({
            code: "undeclaredAction",
            name,
            message: `The widget bridge manifest does not declare a "${name}" action.`,
          });
          fail(id, -32000, `The "${name}" action is not declared by this widget.`);
          return;
        }
        const args = params.arguments ?? {};
        if (!Predicate.isObject(args)) {
          fail(id, -32602, "t3.watch/action arguments must be an object.");
          return;
        }
        answer(id, () =>
          options.invokeAction({ name, arguments: args as Record<string, unknown> }),
        );
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  return {
    receive: (data) => {
      if (disposed || !Predicate.isObject(data) || data.jsonrpc !== "2.0") return;
      if (jsonBytes(data) > MAX_MESSAGE_BYTES) {
        if (isId(data.id) && typeof data.method === "string") {
          fail(data.id, -32600, "Message too large.");
        }
        return;
      }
      // Only requests move the bridge; notifications and host-bound replies
      // from the frame carry no meaning on this protocol.
      const method = data.method;
      if (typeof method !== "string" || !isId(data.id)) return;
      const params = Predicate.isObject(data.params) ? data.params : {};
      handleRequest(data.id, method, params);
    },
    deliver: (name, item) => {
      if (!open.has(name)) return;
      notify(WATCH_APP_NOTIFICATIONS.data, { name, item });
    },
    deliverError: (name, message) => {
      if (!open.has(name)) return;
      notify(WATCH_APP_NOTIFICATIONS.dataError, { name, error: { message } });
    },
    updateHostContext: () => {
      notify(WATCH_APP_NOTIFICATIONS.hostContext, options.hostContext?.() ?? {});
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      opening.clear();
      // Deleting each visited name is safe while iterating a Set.
      for (const name of open) closeName(name);
    },
  };
}

// ── The generated document ────────────────────────────────────────────────

/**
 * The fixed document prelude: defines `globalThis.T3` (`h`/`Fragment` for the
 * JSX pragma, `render`, and the bridge client) before the bundle runs, and the
 * transport both sides of the bridge share — `ReactNativeWebView` inside the
 * mobile WebView, `window.parent` postMessage in a real frame. Because the same
 * prelude text renders on both surfaces, the generated document is
 * byte-identical between web srcdoc and mobile `source.html`.
 *
 * Keep this free of backticks, `${`, and `</script>`; its SHA-256 authorizes it
 * in the document CSP via `WATCH_APP_PRELUDE_SCRIPT_HASH` (asserted by tests).
 */
export const WATCH_APP_PRELUDE = `(function(){
var nextRequestId=0;
var pending=Object.create(null);
var dataHandlers=Object.create(null);
var errorHandlers=Object.create(null);
var contextListeners=[];
var currentContext=null;
var Fragment="t3-watch-fragment";
var nativeBridge=typeof window.ReactNativeWebView==="undefined"?null:window.ReactNativeWebView;
function post(message){
if(nativeBridge!==null){nativeBridge.postMessage(JSON.stringify(message));}
else{window.parent.postMessage(message,"*");}
}
function request(method,params){
var id="watch-"+String(nextRequestId);nextRequestId+=1;
return new Promise(function(resolve,reject){
pending[id]={resolve:resolve,reject:reject};
post({jsonrpc:"2.0",id:id,method:method,params:params||{}});
});
}
function eachHandler(handlers,name,call){
var list=handlers[name];
if(list){for(var i=0;i<list.length;i++){call(list[i]);}}
}
function handle(message){
if(!message||typeof message!=="object"||message.jsonrpc!=="2.0"){return;}
if(typeof message.method!=="string"){
var entry=pending[message.id];
if(entry){
delete pending[message.id];
if(message.error){entry.reject(new Error(message.error.message||"Request failed."));}
else{entry.resolve(message.result);}
}
return;
}
var params=message.params||{};
if(message.method==="t3.watch/data"){
eachHandler(dataHandlers,params.name,function(handler){handler(params.item);});
}else if(message.method==="t3.watch/data-error"){
eachHandler(errorHandlers,params.name,function(handler){
handler((params.error&&params.error.message)||"Subscription failed.");
});
}else if(message.method==="t3.watch/context"){
currentContext=params;
for(var i=0;i<contextListeners.length;i++){contextListeners[i](params);}
}
}
if(nativeBridge!==null){
window.__t3WatchAppReceive=function(message){handle(message);};
}else{
window.addEventListener("message",function(event){handle(event.data);});
}
function append(parent,child){
if(child===null||child===undefined||child===false||child===true){return;}
if(Array.isArray(child)){for(var i=0;i<child.length;i++){append(parent,child[i]);}return;}
if(child instanceof Node){parent.appendChild(child);return;}
parent.appendChild(document.createTextNode(String(child)));
}
var svgTags={svg:1,path:1,circle:1,rect:1,line:1,polyline:1,polygon:1,g:1,text:1,ellipse:1,defs:1,use:1};
function setProp(element,key,value,svg){
if(key==="children"||value===null||value===undefined||value===false){return;}
if(key==="className"){element.setAttribute("class",String(value));return;}
if(key==="style"){
if(typeof value==="string"){element.style.cssText=value;}
else{for(var name in value){element.style[name]=value[name];}}
return;
}
if(key.slice(0,2)==="on"&&typeof value==="function"){
element.addEventListener(key.slice(2).toLowerCase(),value);
return;
}
if(value===true){element.setAttribute(key,"");return;}
if(!svg&&key in element&&typeof element[key]!=="function"){element[key]=value;return;}
element.setAttribute(key,String(value));
}
function h(type,props){
var children=Array.prototype.slice.call(arguments,2);
if(type===Fragment){
var fragment=document.createDocumentFragment();
append(fragment,children);
return fragment;
}
if(typeof type==="function"){
var nextProps={};
if(props){for(var key in props){nextProps[key]=props[key];}}
if(children.length>0){nextProps.children=children.length===1?children[0]:children;}
return type(nextProps);
}
var svg=svgTags[type]===1;
var element=svg?document.createElementNS("http://www.w3.org/2000/svg",type):document.createElement(type);
if(props){for(var prop in props){setProp(element,prop,props[prop],svg);}}
append(element,children);
return element;
}
var root=null;
globalThis.T3={
h:h,
Fragment:Fragment,
render:function(component){
if(root===null){root=document.getElementById("root");}
if(root===null){return;}
var node=typeof component==="function"?component():component;
root.replaceChildren(node===null||node===undefined?[]:[node]);
},
subscribe:function(name,onData,onError){
if(dataHandlers[name]){dataHandlers[name].push(onData);}
else{dataHandlers[name]=[onData];}
if(onError){
if(errorHandlers[name]){errorHandlers[name].push(onError);}
else{errorHandlers[name]=[onError];}
}
request("t3.watch/subscribe",{name:name}).then(null,function(error){
eachHandler(errorHandlers,name,function(handler){handler(error.message||"Subscription failed.");});
});
var released=false;
return function(){
if(released){return;}
released=true;
var list=dataHandlers[name];
if(list){
var index=list.indexOf(onData);
if(index>=0){list.splice(index,1);}
if(list.length===0){
delete dataHandlers[name];
delete errorHandlers[name];
request("t3.watch/unsubscribe",{name:name}).then(null,function(){});
}
}
};
},
action:function(name,args){
return request("t3.watch/action",{name:name,arguments:args||{}});
},
context:function(){
if(currentContext!==null){return Promise.resolve(currentContext);}
return request("t3.watch/context").then(function(context){currentContext=context;return context;});
},
onContext:function(listener){
contextListeners.push(listener);
return function(){
var index=contextListeners.indexOf(listener);
if(index>=0){contextListeners.splice(index,1);}
};
}
};
})();`;

/**
 * Base64 SHA-256 of `WATCH_APP_PRELUDE`, the CSP hash-source the document
 * script-src lists alongside the artifact hash. Verified against the prelude
 * text by test — a prelude edit without a hash bump breaks every widget.
 */
export const WATCH_APP_PRELUDE_SCRIPT_HASH = "YzneTOG5R4kZXO5N/Vw3LXx5uE/c/spQYKCrn+/GvDs=";

const SCRIPT_HASH_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The frame document's Content-Security-Policy, sent as a meta tag so the same
 * policy governs a srcdoc iframe (which cannot carry response headers) and the
 * mobile WebView. Zero network: `default-src 'none'`, `connect-src 'none'`, no
 * `img-src`/`font-src`. `style-src 'unsafe-inline'` permits the inline base
 * style and widget-authored inline styles — a deliberate tradeoff recorded in
 * the plan; scripts get no such allowance and are hash-authorized only.
 */
export function watchAppContentSecurityPolicy(scriptHash: string): string {
  if (!SCRIPT_HASH_PATTERN.test(scriptHash)) {
    throw new Error(`Invalid widget script hash: ${JSON.stringify(scriptHash)}`);
  }
  return `default-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; script-src 'sha256-${WATCH_APP_PRELUDE_SCRIPT_HASH}' 'sha256-${scriptHash}'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`;
}

/**
 * The srcdoc/source.html for one published widget: CSP meta first, then the
 * prelude that defines `T3`, then the transpiled IIFE bundle — each inline
 * script authorized by its own CSP hash. `scriptHash` must be the record's
 * base64 SHA-256 of the emitted bundle; a mismatch blocks the script by design.
 * The bundle is spliced verbatim so the hash matches the artifact bytes; a
 * literal `</script>` inside the bundle would truncate its block and fail the
 * hash check, which degrades to a dead widget rather than an injected one.
 */
export function buildWatchAppDocument(input: {
  readonly bundle: string;
  readonly scriptHash: string;
}): string {
  const csp = watchAppContentSecurityPolicy(input.scriptHash);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;padding:0;background:transparent}body{font:13px/1.45 system-ui,sans-serif}*{box-sizing:border-box}</style></head><body><div id="root"></div><script>${WATCH_APP_PRELUDE}</script><script>${input.bundle}</script></body></html>`;
}

// ── Artifact state ────────────────────────────────────────────────────────

/** What a widget shell renders for one `agent:<sourceId>` kind. */
export type WatchAppArtifactState =
  /** Record or bundle still in flight. */
  | { readonly _tag: "pending" }
  /** Nothing was ever published under this source id. */
  | { readonly _tag: "missing" }
  /** The record carries a typed `transpileFailed` state. */
  | { readonly _tag: "failed"; readonly record: WatchWidgetSourceRecord }
  /** Bundle in hand; the frame mounts. `scriptHash` is the non-null CSP hash. */
  | {
      readonly _tag: "ready";
      readonly record: WatchWidgetSourceRecord;
      readonly bundle: string;
      readonly scriptHash: string;
    };

/**
 * Resolves the stream of source records plus the fetched bundle into one
 * renderable state. `record` is `undefined` while its stream is still loading
 * and `null` once nothing is published; `bundle` is `undefined` while a
 * `ready` record's artifact is still being fetched, `null` once a fetch came
 * back empty.
 */
export function resolveWatchAppArtifact(
  record: WatchWidgetSourceRecord | null | undefined,
  bundle: string | null | undefined,
): WatchAppArtifactState {
  if (record === undefined) return { _tag: "pending" };
  if (record === null) return { _tag: "missing" };
  if (record.status === "failed" || record.scriptHash === null) {
    return { _tag: "failed", record };
  }
  if (bundle === undefined || bundle === null) return { _tag: "pending" };
  return { _tag: "ready", record, bundle, scriptHash: record.scriptHash };
}

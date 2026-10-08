/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { Collection as Records, bootSqlite } from "@crvouga/mockingbird-service";
import type { Store } from "./store.js";
import { createHmac } from "./crypto.js";

export interface WebhookSubscription {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  owner: string;
  repo?: string;
}

export interface WebhookDelivery {
  id: number;
  hook_id: number;
  event: string;
  action?: string;
  payload: unknown;
  status_code: number | null;
  delivered_at: string;
  duration: number | null;
  success: boolean;
}

export interface WebhookHeaderContext {
  event: string;
  action?: string;
  body: string;
  subscription: Readonly<WebhookSubscription>;
  deliveryId: number;
}

export type WebhookHeaderFactory = (context: WebhookHeaderContext) => Record<string, string>;

const MAX_DELIVERIES = 1000;

function githubHeaders({ event, body, subscription, deliveryId }: WebhookHeaderContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": String(deliveryId),
  };

  if (subscription.secret) {
    const hmac = createHmac("sha256", subscription.secret).update(body).digest("hex");
    headers["X-Hub-Signature-256"] = `sha256=${hmac}`;
  }

  return headers;
}

type DispatchState = { subscriptions: WebhookSubscription[]; deliveries: WebhookDelivery[]; subscriptionId: number; deliveryId: number };
export class WebhookDispatcher {
  private readonly records: Records<DispatchState>;
  private readonly now: () => number;
  private headerFactory: WebhookHeaderFactory = githubHeaders;
  constructor(private readonly options: { signal?: AbortSignal; neutral?: boolean; store?: Store } = {}) {
    this.records = new Records(options.store?.sqlite ?? bootSqlite(), options.store?.namespace ?? "webhooks", "provider_webhooks");
    this.now = options.store?.now ?? (() => Date.now());
    if (options.neutral) this.headerFactory = () => ({"Content-Type":"application/json"});
  }
  private load(): DispatchState { return this.records.get("state") ?? {subscriptions:[],deliveries:[],subscriptionId:1,deliveryId:1}; }
  private save(state: DispatchState): void { if(this.records.has("state")) this.records.update("state",state); else this.records.insert("state",state); }
  setHeaderFactory(factory: WebhookHeaderFactory): void { this.headerFactory = factory; }
  register(sub: Omit<WebhookSubscription,"id"> & {id?:number}): WebhookSubscription {
    const state = this.load(); const id = sub.id ?? state.subscriptionId;
    state.subscriptionId = Math.max(state.subscriptionId,id+1);
    const subscription = {...sub,id}; state.subscriptions.push(subscription); this.save(state); return subscription;
  }
  unregister(id:number): boolean {
    const state = this.load(); const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter(sub => sub.id !== id);
    this.save(state); return state.subscriptions.length !== before;
  }
  getSubscription(id:number): WebhookSubscription | undefined { return this.load().subscriptions.find(sub => sub.id === id); }
  getSubscriptions(owner?:string,repo?:string): WebhookSubscription[] { return this.load().subscriptions.filter(sub => (!owner || sub.owner === owner) && (repo === undefined || sub.repo === repo)); }
  updateSubscription(id:number,data:Partial<Pick<WebhookSubscription,"url"|"events"|"active"|"secret">>): WebhookSubscription | undefined {
    const state = this.load(); const sub = state.subscriptions.find(sub => sub.id === id); if(!sub) return undefined;
    Object.assign(sub,data); this.save(state); return sub;
  }
  async dispatch(event:string,action:string|undefined,payload:unknown,owner:string,repo?:string): Promise<void> {
    const matching = this.load().subscriptions.filter(sub => sub.active && sub.owner === owner && sub.repo === repo && (event === "ping" || sub.events.includes("*") || sub.events.includes(event)));
    for(const subscription of matching) {
      const state = this.load();
      const delivery: WebhookDelivery = {id:state.deliveryId++,hook_id:subscription.id,event,action,payload,status_code:null,delivered_at:new Date(this.now()).toISOString(),duration:null,success:false};
      state.deliveries.push(delivery); if(state.deliveries.length > MAX_DELIVERIES) state.deliveries.shift(); this.save(state);
      const body = JSON.stringify(payload); const start = this.now();
      try {
        const response = await fetch(subscription.url,{method:"POST",headers:this.headerFactory({event,action,body,subscription,deliveryId:delivery.id}),body,signal:this.options.signal ? AbortSignal.any([this.options.signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)});
        delivery.status_code = response.status; delivery.success = response.ok; delivery.duration = this.now()-start;
      } catch { delivery.duration=0; delivery.success=false; }
      const current = this.load(); const index = current.deliveries.findIndex(row => row.id === delivery.id);
      if(index >= 0) { current.deliveries[index] = delivery; this.save(current); }
    }
  }
  getDeliveries(hookId?:number): WebhookDelivery[] { return this.load().deliveries.filter(delivery => hookId === undefined || delivery.hook_id === hookId); }
  clear(): void { this.records.delete("state"); }
}

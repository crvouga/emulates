import { createServer } from "node:http"
import { snapshotNamespace, restoreNamespace } from "@crvouga/mockingbird-service"
import { Store as NativeStore } from "../../../http/provider/src/vendor/core/store.js"
export * from "../../../http/provider/src/vendor/core/index.js"
export class Store extends NativeStore {
 snapshot() { this.flush(); return snapshotNamespace(this.sqlite,this.namespace) }
 restore(snapshot: ReturnType<typeof snapshotNamespace>) {restoreNamespace(this.sqlite,this.namespace,snapshot);this.begin()}
}
// A test-only Node listener around the portable Fetch handler.
export function serve(options:{fetch:(request:Request)=>Response|Promise<Response>;port?:number;hostname?:string}) {
 const server=createServer(async (incoming,outgoing)=>{
  try {
   const chunks:Buffer[]=[]
   for await(const chunk of incoming) chunks.push(Buffer.from(chunk))
   const headers=new Headers()
   for(const [name,value] of Object.entries(incoming.headers)) if(value!==undefined) headers.set(name,Array.isArray(value)?value.join(","):value)
   const method=incoming.method ?? "GET"
   const request=new Request(`http://${incoming.headers.host}${incoming.url}`,{method,headers,...(method==="GET"||method==="HEAD"?{}:{body:Buffer.concat(chunks)})})
   const response=await options.fetch(request)
   outgoing.statusCode=response.status
   response.headers.forEach((value,name)=>outgoing.setHeader(name,value))
   outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch {outgoing.statusCode=500;outgoing.end()}
 })
 server.listen(options.port ?? 0,options.hostname ?? "127.0.0.1")
 return server
}

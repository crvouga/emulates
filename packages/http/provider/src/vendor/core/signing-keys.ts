import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose"
import type { Store } from "./store.js"

/** Synthetic OIDC identities are namespace state, including across process restarts. */
export async function signingKeyPair(store: Store, provider: string) {
  const id = `${provider}.oauth.signingKeys`
  let saved = store.getData<{ privateKey: JWK; publicKey: JWK }>(id)
  if (!saved) {
    const pair = await generateKeyPair("RS256", { extractable: true })
    saved = { privateKey: await exportJWK(pair.privateKey), publicKey: await exportJWK(pair.publicKey) }
    store.setData(id, saved)
  }
  return { privateKey: await importJWK(saved.privateKey, "RS256"), publicKey: await importJWK(saved.publicKey, "RS256") }
}

declare module "virtual:emulators/catalog" {
  const catalog: import("./lib/types.ts").Catalog
  export default catalog
}

declare module "virtual:emulators/runtimes" {
  // biome-ignore lint/suspicious/noExplicitAny: each service module has its own export shape.
  export const loaders: Record<string, () => Promise<any>>
}

declare module "virtual:emulators/examples" {
  export const exampleLoaders: Record<string, () => Promise<import("./lib/types.ts").ExampleModule>>
}

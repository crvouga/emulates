declare module "virtual:emulates/catalog" {
  const catalog: import("./lib/types.ts").Catalog
  export default catalog
}

declare module "virtual:emulates/runtimes" {
  // biome-ignore lint/suspicious/noExplicitAny: each service module has its own export shape.
  export const loaders: Record<string, () => Promise<any>>
}

declare module "virtual:emulates/examples" {
  export const exampleLoaders: Record<string, () => Promise<import("./lib/types.ts").ExampleModule>>
}

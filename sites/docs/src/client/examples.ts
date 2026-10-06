import { exampleLoaders } from "virtual:emulates/examples"
import { defineExampleLauncher } from "./exampleModal.ts"

defineExampleLauncher("service-example", (key) => exampleLoaders[key])

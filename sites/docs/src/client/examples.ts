import { exampleLoaders } from "virtual:emulators/examples"
import { defineExampleLauncher } from "./exampleModal.ts"

defineExampleLauncher("service-example", (key) => exampleLoaders[key])

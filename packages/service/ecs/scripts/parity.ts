console.error(
  "ECS RunTask creates billable compute; live parity is intentionally not run by default. An authorized isolated ECS cluster, task definition and explicit execution approval are required. Use the official RunTask docs and the pinned boto3 drop-in for this WIP surface.",
)
process.exit(2)

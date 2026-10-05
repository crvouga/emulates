export const input = {
  cluster: "default",
  taskDefinition: "fixture",
  launchType: "FARGATE",
  count: 1,
  networkConfiguration: {
    awsvpcConfiguration: {
      subnets: ["subnet-fixture"],
      securityGroups: ["sg-fixture"],
      assignPublicIp: "DISABLED",
    },
  },
  overrides: {
    containerOverrides: [
      {
        name: "app",
        command: ["echo", "fixture"],
        environment: [{ name: "MODE", value: "fixture" }],
      },
    ],
  },
}
export const call = (
  fetcher: (r: Request) => Promise<Response>,
  body: unknown = input,
  headers: Record<string, string> = {},
) =>
  fetcher(
    new Request("http://mock.local/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AmazonEC2ContainerServiceV20141113.RunTask",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )

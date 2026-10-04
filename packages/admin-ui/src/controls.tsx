import { DeleteOutlined, PlusOutlined } from "@ant-design/icons"
import {
  App,
  Button,
  Card,
  Descriptions,
  Flex,
  Form,
  Input,
  Select,
  Space,
  Statistic,
  Switch,
  Tag,
  Typography,
} from "antd"
import { useState } from "react"
import { DataTable, ErrorNotice, Json, Refresh, useAction, useResource } from "./components.js"
import type { Api, Clock, Journal, StateView } from "./model.js"
import { errorMessage, text } from "./model.js"

export function Overview({ api, revision }: { api: Api; revision: number }) {
  const health = useResource<Record<string, unknown>>(api, "/health", revision)
  const state = useResource<StateView>(api, "/state", revision)
  const clock = useResource<Clock>(api, "/clock", revision)
  const journal = useResource<Journal>(api, "/requests?limit=8", revision)
  const { modal, message } = App.useApp()
  const reset = useAction(api, () => {
    state.reload()
    journal.reload()
    void message.success("Namespace reset")
  })
  return (
    <Flex vertical gap="large">
      <Typography.Title level={3} style={{ margin: 0 }}>
        Overview
      </Typography.Title>
      <ErrorNotice
        error={health.error ?? state.error ?? clock.error ?? journal.error ?? reset.error}
        retry={() => {
          health.reload()
          state.reload()
          clock.reload()
          journal.reload()
        }}
      />
      <Flex gap="middle" wrap>
        <Card loading={health.loading} style={{ flex: "1 1 200px" }}>
          <Statistic title="Service" value={text(health.data?.service)} />
        </Card>
        <Card loading={state.loading} style={{ flex: "1 1 200px" }}>
          <Statistic title="Collections" value={state.data?.collections.length ?? 0} />
        </Card>
        <Card loading={state.loading} style={{ flex: "1 1 200px" }}>
          <Statistic
            title="Records"
            value={state.data?.collections.reduce((sum, item) => sum + item.count, 0) ?? 0}
          />
        </Card>
      </Flex>
      <Card title="Environment" loading={clock.loading || health.loading}>
        <Descriptions
          column={1}
          bordered
          items={[
            {
              key: "status",
              label: "Status",
              children: <Tag color="success">{text(health.data?.status)}</Tag>,
            },
            { key: "namespace", label: "Namespace", children: api.namespace() },
            {
              key: "time",
              label: "Clock",
              children: clock.data
                ? `${new Date(clock.data.now).toLocaleString()} · ${clock.data.frozen ? "Frozen" : "Live"}`
                : "—",
            },
          ]}
        />
      </Card>
      <Card title="Recent requests">
        <DataTable
          rows={journal.data?.requests ?? []}
          columns={["method", "path", "status", "operationId", "durationMs"]}
          loading={journal.loading}
        />
      </Card>
      <Card title="Reset namespace">
        <Flex gap="middle" wrap align="center">
          <Typography.Text type="secondary">
            Reset data in {api.namespace()}. Other namespaces are unaffected.
          </Typography.Text>
          <Button
            danger
            loading={reset.busy}
            onClick={() =>
              modal.confirm({
                title: `Reset ${api.namespace()}?`,
                content: "This clears the namespace's current data.",
                okText: "Reset namespace",
                okButtonProps: { danger: true },
                onOk: async () => {
                  if (!(await reset.run("POST", "/reset", {}))) throw new Error("Reset failed")
                },
              })
            }
          >
            Reset namespace
          </Button>
        </Flex>
      </Card>
    </Flex>
  )
}

export function ClockView({ api, revision }: { api: Api; revision: number }) {
  const clock = useResource<Clock>(api, "/clock", revision)
  const { message } = App.useApp()
  const action = useAction(api, () => {
    clock.reload()
    void message.success("Clock updated")
  })
  return (
    <Flex vertical gap="large">
      <Flex justify="space-between" gap="middle" wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Clock
        </Typography.Title>
        <Refresh loading={clock.loading} onClick={clock.reload} />
      </Flex>
      <ErrorNotice error={clock.error ?? action.error} retry={clock.reload} />
      <Card title="Current time" loading={clock.loading}>
        <Flex vertical gap="middle">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {clock.data ? new Date(clock.data.now).toISOString() : "—"}
          </Typography.Title>
          <Flex gap="middle" align="center">
            <Switch
              aria-label="Freeze clock"
              checked={clock.data?.frozen ?? false}
              loading={action.busy}
              onChange={(freeze) => void action.run("POST", "/clock", { freeze })}
            />
            <Typography.Text>Freeze clock</Typography.Text>
          </Flex>
          <Space wrap>
            {[
              ["−1h", -3600000],
              ["+1m", 60000],
              ["+15m", 900000],
              ["+1h", 3600000],
              ["+1d", 86400000],
            ].map(([label, advance]) => (
              <Button
                key={String(label)}
                disabled={action.busy}
                onClick={() => void action.run("POST", "/clock", { advance })}
              >
                {label}
              </Button>
            ))}
          </Space>
          <Button
            loading={action.busy}
            onClick={() => void action.run("POST", "/clock", { reset: true })}
          >
            Reset clock
          </Button>
        </Flex>
      </Card>
      <Card title="Set an instant">
        <Form
          layout="vertical"
          onFinish={(values: { set: string }) =>
            void action.run("POST", "/clock", { set: values.set })
          }
        >
          <Form.Item
            label="ISO 8601 timestamp"
            name="set"
            rules={[
              { required: true },
              {
                validator: async (_, value: string) => {
                  if (!Number.isFinite(Date.parse(value))) throw new Error("Enter an ISO timestamp")
                },
              },
            ]}
          >
            <Input placeholder="2026-01-01T00:00:00Z" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={action.busy}>
            Set time
          </Button>
        </Form>
      </Card>
    </Flex>
  )
}

export function FaultsView({ api, revision }: { api: Api; revision: number }) {
  const faults = useResource<{ faults: Record<string, unknown>[] }>(api, "/faults", revision)
  const presets = useResource<{ presets: { name: string }[] }>(api, "/faults/presets", revision)
  const [preset, setPreset] = useState<string | undefined>()
  const [custom, setCustom] = useState('{\n  "status": 503,\n  "count": 1\n}')
  const [parseError, setParseError] = useState<string | null>(null)
  const { message, modal } = App.useApp()
  const action = useAction(api, () => {
    faults.reload()
    void message.success("Fault rules updated")
  })
  const add = () => {
    setParseError(null)
    try {
      void action.run("POST", "/faults", preset ? { preset } : (JSON.parse(custom) as unknown))
    } catch (error) {
      setParseError(errorMessage(error))
    }
  }
  return (
    <Flex vertical gap="large">
      <Flex justify="space-between" wrap gap="middle">
        <Typography.Title level={3} style={{ margin: 0 }}>
          Faults
        </Typography.Title>
        <Refresh loading={faults.loading} onClick={faults.reload} />
      </Flex>
      <ErrorNotice error={faults.error ?? action.error ?? parseError} retry={faults.reload} />
      <Card title="Add a fault">
        <Flex vertical gap="middle">
          <Select
            aria-label="Fault preset"
            placeholder="Custom rule"
            allowClear
            style={{ width: "100%", maxWidth: 460 }}
            value={preset}
            onChange={setPreset}
            options={
              presets.data?.presets.map((item) => ({ label: item.name, value: item.name })) ?? []
            }
          />
          {!preset && (
            <Form layout="vertical">
              <Form.Item
                label="Rule JSON"
                help="Set a status, delayMs, drop, or service effect. Optional match fields include method, pathPrefix, and operationId."
              >
                <Input.TextArea
                  aria-label="Fault rule JSON"
                  value={custom}
                  onChange={(event) => setCustom(event.target.value)}
                  rows={6}
                  spellCheck={false}
                />
              </Form.Item>
            </Form>
          )}
          <Button type="primary" icon={<PlusOutlined />} loading={action.busy} onClick={add}>
            Add fault
          </Button>
        </Flex>
      </Card>
      <Card
        title="Active rules"
        extra={
          <Button
            danger
            icon={<DeleteOutlined />}
            disabled={!faults.data?.faults.length}
            onClick={() =>
              modal.confirm({
                title: "Clear all fault rules?",
                onOk: async () => {
                  if (!(await action.run("DELETE", "/faults"))) throw new Error("Clear failed")
                },
              })
            }
          >
            Clear all
          </Button>
        }
      >
        <DataTable rows={faults.data?.faults ?? []} loading={faults.loading} />
      </Card>
    </Flex>
  )
}

export function JournalView({ api, revision }: { api: Api; revision: number }) {
  const journal = useResource<Journal>(api, "/requests?limit=1000", revision)
  const { message, modal } = App.useApp()
  const action = useAction(api, () => {
    journal.reload()
    void message.success("Journal cleared")
  })
  return (
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between" align="center">
        <Typography.Title level={3} style={{ margin: 0 }}>
          Request journal
        </Typography.Title>
        <Space>
          <Refresh loading={journal.loading} onClick={journal.reload} />
          <Button
            danger
            loading={action.busy}
            icon={<DeleteOutlined />}
            onClick={() =>
              modal.confirm({
                title: "Clear this namespace's journal?",
                onOk: async () => {
                  if (!(await action.run("DELETE", "/requests"))) throw new Error("Clear failed")
                },
              })
            }
          >
            Clear journal
          </Button>
        </Space>
      </Flex>
      <Typography.Paragraph type="secondary">
        The latest 1,000 requests in this namespace. Expand a row for metadata; request bodies are
        never stored.
      </Typography.Paragraph>
      <ErrorNotice error={journal.error ?? action.error} retry={journal.reload} />
      <DataTable
        rows={journal.data?.requests ?? []}
        columns={["at", "method", "path", "status", "operationId", "durationMs", "faultId"]}
        loading={journal.loading}
      />
    </Flex>
  )
}

export function RoutesView({
  api,
  revision,
  standardRoutes,
}: {
  api: Api
  revision: number
  standardRoutes: readonly string[]
}) {
  const routes = useResource<{ routes: string[] }>(api, "/", revision)
  const [selected, setSelected] = useState<string | undefined>()
  const [body, setBody] = useState("{}")
  const [result, setResult] = useState<unknown>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<Record<string, string>>()
  const params = [...(selected ?? "").matchAll(/:([\w]+)/g)].map((match) => match[1] ?? "")
  const send = async (values: Record<string, string>) => {
    if (!selected) return
    const [method = "GET", template = "/"] = selected.split(" ")
    const path = template.replace(/:([\w]+)/g, (_, name: string) =>
      encodeURIComponent(values[name] ?? ""),
    )
    setBusy(true)
    setError(null)
    setResult(undefined)
    try {
      setResult(
        await api.send(
          method,
          path,
          method === "GET" || method === "DELETE" ? undefined : (JSON.parse(body) as unknown),
        ),
      )
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between">
        <Typography.Title level={3} style={{ margin: 0 }}>
          Routes
        </Typography.Title>
        <Refresh loading={routes.loading} onClick={routes.reload} />
      </Flex>
      <ErrorNotice error={routes.error ?? error} retry={routes.reload} />
      <Card title="Admin request runner">
        <Flex vertical gap="middle">
          <Select
            aria-label="Admin route"
            showSearch
            optionFilterProp="label"
            placeholder="Select a route"
            value={selected}
            onChange={(route) => {
              setSelected(route)
              setResult(undefined)
              setError(null)
              form.resetFields()
            }}
            options={
              routes.data?.routes.map((route) => ({
                label: `${route}${standardRoutes.includes(route) ? "" : " · service"}`,
                value: route,
              })) ?? []
            }
          />
          <Form form={form} layout="vertical" onFinish={send}>
            {params.map((name) => (
              <Form.Item key={name} name={name} label={name} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            ))}
            {selected && !selected.startsWith("GET ") && !selected.startsWith("DELETE ") && (
              <Form.Item label="JSON body">
                <Input.TextArea
                  aria-label="Request body"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={8}
                  spellCheck={false}
                />
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" disabled={!selected} loading={busy}>
              Send request
            </Button>
          </Form>
          {result !== undefined && <Json value={result} />}
        </Flex>
      </Card>
    </Flex>
  )
}

export function TimelineView({ api, revision }: { api: Api; revision: number }) {
  const timeline = useResource<{
    branches: Record<string, string>
    checkpoints: Record<string, unknown>[]
  }>(api, "/timeline", revision)
  const [branch, setBranch] = useState("main")
  const [fork, setFork] = useState("")
  const { message, modal } = App.useApp()
  const action = useAction(api, () => {
    timeline.reload()
    void message.success("Timeline updated")
  })
  return (
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between">
        <Typography.Title level={3} style={{ margin: 0 }}>
          Checkpoints
        </Typography.Title>
        <Refresh loading={timeline.loading} onClick={timeline.reload} />
      </Flex>
      <ErrorNotice error={timeline.error ?? action.error} retry={timeline.reload} />
      <Card title="Branches">
        <Flex vertical gap="middle">
          <Select
            aria-label="Branch"
            style={{ width: "100%", maxWidth: 400 }}
            value={branch}
            onChange={setBranch}
            options={Object.keys(timeline.data?.branches ?? { main: "" }).map((name) => ({
              label: name,
              value: name,
            }))}
          />
          <Space wrap>
            <Button
              type="primary"
              loading={action.busy}
              onClick={() => void action.run("POST", "/checkpoints", { branch })}
            >
              Create checkpoint
            </Button>
          </Space>
          <Flex gap="small" wrap>
            <Input
              aria-label="New branch name"
              placeholder="New branch name"
              value={fork}
              onChange={(event) => setFork(event.target.value)}
              style={{ maxWidth: 320 }}
            />
            <Button
              disabled={!fork.trim()}
              loading={action.busy}
              onClick={() =>
                void action.run("POST", `/branches/${encodeURIComponent(fork.trim())}`, {})
              }
            >
              Create branch
            </Button>
          </Flex>
        </Flex>
      </Card>
      <Card title="Saved checkpoints">
        <DataTable
          rows={timeline.data?.checkpoints ?? []}
          loading={timeline.loading}
          action={(row) => (
            <Button
              onClick={() =>
                modal.confirm({
                  title: "Restore checkpoint?",
                  content: `Replace ${branch} with ${text(row.id)}.`,
                  okText: "Restore",
                  onOk: async () => {
                    if (
                      !(await action.run(
                        "POST",
                        `/branches/${encodeURIComponent(branch)}/checkout`,
                        { checkpoint: row.id },
                      ))
                    )
                      throw new Error("Restore failed")
                  },
                })
              }
            >
              Restore
            </Button>
          )}
        />
      </Card>
    </Flex>
  )
}

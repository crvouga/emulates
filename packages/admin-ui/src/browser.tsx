import { StyleProvider } from "@ant-design/cssinjs"
import {
  ApiOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  HistoryOutlined,
  MoonOutlined,
  SunOutlined,
  TableOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons"
import {
  App,
  Avatar,
  Button,
  Card,
  ConfigProvider,
  Flex,
  Form,
  Input,
  Layout,
  Menu,
  Result,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from "antd"
import type { ReactNode } from "react"
import { Component, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { createApi } from "./api.js"
import { brandCatalogUrl, brandFor } from "./brand.js"
import { ErrorNotice, useResource } from "./components.js"
import {
  ClockView,
  FaultsView,
  JournalView,
  Overview,
  RoutesView,
  TimelineView,
} from "./controls.js"
import { Members } from "./members.js"
import type { AdminConfig, Api, Manifest, MembersConfig, Panel } from "./model.js"
import { errorMessage } from "./model.js"
import { SqlExplorer } from "./sql.js"
import { StateExplorer } from "./state.js"

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) }
  }
  override render() {
    return this.state.error ? (
      <Result
        status="error"
        title="The admin could not render"
        subTitle={this.state.error}
        extra={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
      />
    ) : (
      this.props.children
    )
  }
}

const remember = (key: string, value?: string): string | null => {
  try {
    if (value !== undefined) sessionStorage.setItem(key, value)
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function Vendor({ config }: { config: AdminConfig }) {
  const [brand, setBrand] = useState<ReturnType<typeof brandFor>>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(brandCatalogUrl(config.brandsUrl, location.href), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
      .then((catalog: unknown) => {
        if (!controller.signal.aborted) setBrand(brandFor(config.service, catalog))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [config])
  if (!brand) return null
  return (
    <Space wrap size="small">
      {brand.logo && <Avatar size={20} src={brand.logo} shape="square" />}
      <Typography.Text title={brand.description}>{brand.vendor}</Typography.Text>
      {brand.website && (
        <Typography.Link href={brand.website} target="_blank" rel="noopener noreferrer">
          Website
        </Typography.Link>
      )}
      {brand.guide && (
        <Typography.Link href={brand.guide} target="_blank" rel="noopener noreferrer">
          Docs
        </Typography.Link>
      )}
      {brand.docs && (
        <Typography.Link href={brand.docs} target="_blank" rel="noopener noreferrer">
          API
        </Typography.Link>
      )}
    </Space>
  )
}

function CustomPanel({ panel, api }: { panel: Panel; api: Api }) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const root = host.current
    if (!root) return
    root.innerHTML = panel.html
    let dispose: unknown
    try {
      if (panel.script) dispose = new Function("root", "api", panel.script)(root, api) as unknown
    } catch (error) {
      setError(errorMessage(error))
    }
    return () => {
      if (typeof dispose === "function") dispose()
      root.replaceChildren()
    }
  }, [panel, api])
  return (
    <Card title={panel.title}>
      <Flex vertical gap="middle">
        {panel.description && <Typography.Paragraph>{panel.description}</Typography.Paragraph>}
        <ErrorNotice error={error} />
        <div ref={host} />
      </Flex>
    </Card>
  )
}

function Workspace({
  host,
  config,
  popupHost,
}: {
  host: HTMLElement
  config: AdminConfig
  popupHost: HTMLElement
}) {
  const params = useMemo(() => new URL(location.href).searchParams, [])
  const [namespace, setNamespace] = useState(params.get("namespace") || "default")
  const [key, setKey] = useState(params.get("admin_key") ?? remember("mockingbird-admin-key") ?? "")
  const [draftKey, setDraftKey] = useState(key)
  const [view, setView] = useState(location.hash.slice(1) || "overview")
  const [revision, setRevision] = useState(0)
  const [narrow, setNarrow] = useState(host.clientWidth < 760)
  const [collapsed, setCollapsed] = useState(false)
  const [dark, setDark] = useState(
    remember("mockingbird-admin-theme") === "dark" ||
      (remember("mockingbird-admin-theme") === null &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  )
  const api = useMemo(() => createApi(config, fetch, namespace, key), [config, namespace, key])
  const manifest = useResource<Manifest>(api, "/ui/manifest")
  const namespaces = useResource<{ namespaces: string[] }>(api, "/namespaces", revision)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 760)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [host])
  useEffect(() => {
    remember("mockingbird-admin-key", key)
    if (params.has("admin_key")) {
      const url = new URL(location.href)
      url.searchParams.delete("admin_key")
      history.replaceState(null, "", url.href)
    }
  }, [key, params])
  const panelList = [...(manifest.data?.panels ?? []), ...(manifest.data?.extensions ?? [])]
  const hasSql = panelList.some((panel) => panel.kind === "sql")
  const nav = [
    { key: "overview", icon: <AppstoreOutlined />, label: "Overview" },
    { key: "state", icon: <DatabaseOutlined />, label: "State" },
    { key: "clock", icon: <FieldTimeOutlined />, label: "Clock" },
    { key: "faults", icon: <ThunderboltOutlined />, label: "Faults" },
    { key: "journal", icon: <HistoryOutlined />, label: "Journal" },
    { key: "checkpoints", icon: <BranchesOutlined />, label: "Checkpoints" },
    { key: "routes", icon: <ApiOutlined />, label: "Routes" },
    ...panelList.map((panel) => ({
      key: panel.id,
      icon: panel.kind === "sql" ? <TableOutlined /> : <AppstoreOutlined />,
      label: panel.title,
    })),
  ]
  const selected = nav.some((item) => item.key === view) ? view : "overview"
  let content: ReactNode
  const common = { api, revision }
  switch (selected) {
    case "overview":
      content = <Overview {...common} />
      break
    case "state":
      content = <StateExplorer {...common} sql={hasSql} />
      break
    case "clock":
      content = <ClockView {...common} />
      break
    case "faults":
      content = <FaultsView {...common} />
      break
    case "journal":
      content = <JournalView {...common} />
      break
    case "checkpoints":
      content = <TimelineView {...common} />
      break
    case "routes":
      content = <RoutesView {...common} standardRoutes={config.standardRoutes} />
      break
    default: {
      const panel = panelList.find((panel) => panel.id === selected)
      content =
        panel?.kind === "sql" ? (
          <SqlExplorer {...common} />
        ) : (
          panel && <CustomPanel panel={panel} api={api} />
        )
    }
  }
  return (
    <ConfigProvider
      getPopupContainer={() => popupHost}
      theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <App
        message={{ getContainer: () => popupHost }}
        notification={{ getContainer: () => popupHost }}
        style={{ minHeight: "100%" }}
      >
        <Layout style={{ minHeight: "100%" }}>
          <Layout.Header
            style={{
              height: "auto",
              padding: "16px 24px",
              lineHeight: "normal",
              background: dark ? "#141414" : "#fff",
            }}
          >
            <Flex gap="middle" wrap justify="space-between" align="center">
              <Flex vertical gap={4}>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {config.service} <Tag>Admin</Tag>
                </Typography.Title>
                <Vendor config={config} />
              </Flex>
              <Flex wrap gap="small" align="center">
                <Select
                  aria-label="Namespace"
                  showSearch
                  optionFilterProp="label"
                  value={namespace}
                  onChange={setNamespace}
                  style={{ minWidth: 150 }}
                  options={[...new Set([namespace, ...(namespaces.data?.namespaces ?? [])])].map(
                    (name) => ({ value: name, label: name }),
                  )}
                />
                <Form
                  layout="inline"
                  onFinish={() => {
                    setKey(draftKey.trim())
                    setRevision((n) => n + 1)
                  }}
                >
                  <Space.Compact>
                    <Input.Password
                      aria-label="Admin key"
                      placeholder="Admin key"
                      value={draftKey}
                      onChange={(event) => setDraftKey(event.target.value)}
                      style={{ width: 180 }}
                    />
                    <Button htmlType="submit">Connect</Button>
                  </Space.Compact>
                </Form>
                <Button
                  icon={dark ? <SunOutlined /> : <MoonOutlined />}
                  aria-label={dark ? "Use light theme" : "Use dark theme"}
                  onClick={() => {
                    remember("mockingbird-admin-theme", dark ? "light" : "dark")
                    setDark(!dark)
                  }}
                />
                <Button onClick={() => setRevision((n) => n + 1)}>Refresh</Button>
              </Flex>
            </Flex>
          </Layout.Header>
          <Layout style={{ minWidth: 0 }}>
            <Layout.Sider
              theme={dark ? "dark" : "light"}
              width={208}
              collapsedWidth={64}
              collapsed={narrow || collapsed}
              collapsible={!narrow}
              onCollapse={setCollapsed}
            >
              <Menu
                theme={dark ? "dark" : "light"}
                mode="inline"
                selectedKeys={[selected]}
                items={nav}
                onClick={({ key: next }) => {
                  setView(next)
                  const url = new URL(location.href)
                  url.hash = next
                  history.replaceState(null, "", url.href)
                }}
              />
            </Layout.Sider>
            <Layout.Content style={{ minWidth: 0, padding: narrow ? 12 : 24 }}>
              <Flex vertical gap="large">
                <ErrorNotice
                  error={manifest.error ?? namespaces.error}
                  retry={() => {
                    manifest.reload()
                    namespaces.reload()
                  }}
                />
                {manifest.loading ? (
                  <Spin tip="Loading administration…">
                    <div style={{ minHeight: 120 }} />
                  </Spin>
                ) : (
                  <div key={`${namespace}:${key}:${selected}`}>{content}</div>
                )}
              </Flex>
            </Layout.Content>
          </Layout>
        </Layout>
      </App>
    </ConfigProvider>
  )
}

/** Bundled once at build time, then executed inside the admin document's scoped environment. */
export function mount(host: HTMLElement | null, config: AdminConfig): void {
  mountRoot(host, (popupHost) => (
    <Workspace host={host as HTMLElement} config={config} popupHost={popupHost} />
  ))
}

export function mountMembers(host: HTMLElement | null, config: MembersConfig): void {
  mountRoot(host, (popupHost) => (
    <ConfigProvider
      getPopupContainer={() => popupHost}
      theme={{ algorithm: config.dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <App message={{ getContainer: () => popupHost }}>
        <Members config={config} />
      </App>
    </ConfigProvider>
  ))
}

function mountRoot(host: HTMLElement | null, render: (popupHost: HTMLElement) => ReactNode): void {
  if (!host) throw new Error("Admin root is missing")
  const styleRoot = host.getRootNode()
  const mountPoint = document.createElement("div")
  const popupHost = document.createElement("div")
  host.append(mountPoint, popupHost)
  const root = createRoot(mountPoint)
  root.render(
    <Boundary>
      <StyleProvider container={styleRoot instanceof ShadowRoot ? styleRoot : document.head}>
        {render(popupHost)}
      </StyleProvider>
    </Boundary>,
  )
  const dispose = () => root.unmount()
  document.addEventListener("mockingbird:unmount", dispose, { once: true })
  window.addEventListener("pagehide", dispose, { once: true })
}

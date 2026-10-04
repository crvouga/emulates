import { PlayCircleOutlined } from "@ant-design/icons"
import { App, Button, Card, Descriptions, Flex, Form, Input, Select, Tag, Typography } from "antd"
import { useEffect, useRef, useState } from "react"
import { DataTable, ErrorNotice, Refresh, useResource } from "./components.js"
import type { Api, SqlResult, SqlTable } from "./model.js"
import { errorMessage } from "./model.js"

export function SqlExplorer({ api, revision }: { api: Api; revision: number }) {
  const tables = useResource<{ tables: SqlTable[] }>(api, "/sql/tables", revision)
  const [selected, setSelected] = useState("")
  const current =
    tables.data?.tables.find((table) => `${table.schema}.${table.name}` === selected) ??
    tables.data?.tables[0]
  const [sql, setSql] = useState("")
  const [result, setResult] = useState<SqlResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const { message } = App.useApp()
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = async () => {
    if (!sql.trim() || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const response = await api.send<SqlResult>("POST", "/sql/query", { sql })
      if (!alive.current) return
      setResult(response)
      tables.reload()
      void message.success(
        `${response.rowCount ?? response.rows.length} rows${response.truncated ? " (truncated)" : ""}`,
      )
    } catch (error) {
      if (alive.current) setError(errorMessage(error))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <Flex vertical gap="large" style={{ minWidth: 0 }}>
      <Flex wrap gap="middle" justify="space-between" align="center">
        <Typography.Title level={3} style={{ margin: 0 }}>
          SQL
        </Typography.Title>
        <Refresh loading={tables.loading} onClick={tables.reload} />
      </Flex>
      <ErrorNotice error={tables.error} retry={tables.reload} />
      <Card title="Tables">
        <Flex vertical gap="middle">
          <Select<string>
            aria-label="Database table"
            loading={tables.loading}
            showSearch
            optionFilterProp="label"
            placeholder="Choose a table"
            value={current ? `${current.schema}.${current.name}` : null}
            style={{ width: "100%", maxWidth: 500 }}
            onChange={setSelected}
            options={
              tables.data?.tables.map((table) => ({
                label: `${table.schema}.${table.name}`,
                value: `${table.schema}.${table.name}`,
              })) ?? []
            }
          />
          {current && (
            <TableBrowser
              key={`${current.schema}.${current.name}`}
              api={api}
              table={current}
              revision={revision}
            />
          )}
        </Flex>
      </Card>
      <Card title="Query runner">
        <Flex vertical gap="middle">
          <Form layout="vertical" onFinish={run}>
            <Form.Item
              label="SQL statement"
              help="Run a statement against the live database. Command/Ctrl + Enter also runs it."
            >
              <Input.TextArea
                aria-label="SQL statement"
                value={sql}
                onChange={(event) => setSql(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault()
                    void run()
                  }
                }}
                rows={5}
                spellCheck={false}
                placeholder="SELECT * FROM …"
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              icon={<PlayCircleOutlined />}
              loading={busy}
              disabled={!sql.trim()}
            >
              Run query
            </Button>
          </Form>
          <ErrorNotice error={error} />
          {result && (
            <>
              <Tag>
                {result.rowCount ?? result.rows.length} rows{result.truncated ? " · truncated" : ""}
              </Tag>
              <DataTable rows={result.rows} columns={result.columns} />
            </>
          )}
        </Flex>
      </Card>
    </Flex>
  )
}

function TableBrowser({ api, table, revision }: { api: Api; table: SqlTable; revision: number }) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const data = useResource<SqlResult>(
    api,
    `/sql/tables/${encodeURIComponent(table.schema)}/${encodeURIComponent(table.name)}?limit=${size}&offset=${(page - 1) * size}`,
    revision,
  )
  return (
    <Flex vertical gap="middle">
      <ErrorNotice error={data.error} retry={data.reload} />
      <DataTable
        rows={data.data?.rows ?? []}
        columns={table.columns.map((column) => column.name)}
        loading={data.loading}
        total={data.data?.total ?? 0}
        page={page}
        pageSize={size}
        onPage={(next, nextSize) => {
          setPage(nextSize === size ? next : 1)
          setSize(nextSize)
        }}
      />
      <Descriptions
        title="Schema"
        size="small"
        bordered
        column={1}
        items={table.columns.map((column) => ({
          key: column.name,
          label: column.name,
          children: (
            <>
              {column.type} {column.primaryKey && <Tag>Primary key</Tag>}
            </>
          ),
        }))}
      />
    </Flex>
  )
}

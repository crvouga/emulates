# /// script
# requires-python = ">=3.10"
# dependencies = ["requests==2.32.5", "httpx==0.28.1"]
# ///
"""Run with uv against a fresh local mock; never calls the real provider."""
import asyncio
import sys
import httpx
import requests

origin = sys.argv[1].rstrip("/")
assert origin.startswith("http://127.0.0.1:"), "Only a local mock is allowed"
assert requests.__version__ == "2.32.5"
assert httpx.__version__ == "0.28.1"
response = requests.post(origin + "/oauth/oauth2/token", data={
    "grant_type": "refresh_token", "refresh_token": "mock_whoop_refresh",
    "client_id": "mock_client", "client_secret": "mock_client_secret",
}, timeout=10)
response.raise_for_status()
token = response.json()["access_token"]
page = requests.get(origin + "/developer/v2/activity/workout", params={
    "start": "2026-01-01T00:00:00Z", "end": "2026-01-31T00:00:00Z",
}, headers={"Authorization": "Bearer " + token}, timeout=10)
assert page.status_code == 200 and page.json() == {"records": []}

async def main():
    async with httpx.AsyncClient(base_url=origin, timeout=10) as client:
        page = await client.get("/developer/v2/activity/sleep", params={
            "start": "2026-01-01T00:00:00Z",
            "end": "2026-01-02T00:00:00Z",
        }, headers={"Authorization": "Bearer " + token})
        assert page.status_code == 200 and page.json() == {"records": []}
        rejected = await client.post("/oauth/oauth2/token", data={
            "grant_type": "refresh_token", "refresh_token": "mock_invalid_refresh",
            "client_id": "mock_client", "client_secret": "mock_client_secret",
        })
        assert rejected.status_code == 400 and rejected.json()["error"] == "invalid_grant"

asyncio.run(main())
print("requests 2.32.5 and httpx 0.28.1 local wire smoke passed")

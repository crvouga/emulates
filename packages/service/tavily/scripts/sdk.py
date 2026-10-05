"""Pinned AsyncTavilyClient integration against local synthetic fixtures only."""
import asyncio
import json
import sys
import urllib.request
from importlib.metadata import version
from tavily import AsyncTavilyClient
from tavily.errors import InvalidAPIKeyError, UsageLimitExceededError, ForbiddenError, TimeoutError
assert version("tavily-python") == "0.7.17"
endpoint=sys.argv[1].rstrip("/")
def admin(path,body):
    request=urllib.request.Request(endpoint+"/__admin/"+path,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(request) as response:
        return json.load(response)
admin("state/searches",{"id":"fixture","value":{"query":"fixture","answer":"Scripted answer","results":[{"title":"First","url":"https://example.test/1","content":"Synthetic","score":0.9},{"title":"Second","url":"https://example.test/2","content":"Synthetic","score":0.8}]}})
admin("state/extractions",{"id":"fixture-url","value":{"url":"https://example.test/1","raw_content":"Synthetic content"}})
async def main():
    client=AsyncTavilyClient(api_key="mock_tavily_key",api_base_url=endpoint)
    result=await client.search("fixture",max_results=1,search_depth="basic",topic="general",time_range="week",include_answer=True)
    assert len(result["results"])==1 and result["results"][0]["title"]=="First" and result["answer"]=="Scripted answer"
    result=await client.extract(["https://example.test/1","https://example.test/2"])
    assert len(result["results"])==1 and len(result["failed_results"])==1
    try:
        await AsyncTavilyClient(api_key="invalid_fixture",api_base_url=endpoint).search("fixture")
        raise AssertionError("expected invalid API key")
    except InvalidAPIKeyError:
        pass
    for preset,exception in [("quota_exceeded",UsageLimitExceededError),("plan_limit",ForbiddenError),("payg_limit",ForbiddenError)]:
        admin("faults",{"preset":preset,"count":1})
        try:
            await client.search("fixture")
            raise AssertionError("expected SDK error")
        except exception:
            pass
    admin("faults",{"preset":"timeout","count":1})
    try:
        await client.search("fixture",timeout=0.02)
        raise AssertionError("expected timeout")
    except TimeoutError:
        pass
asyncio.run(main())
print("tavily-python 0.7.17 AsyncTavilyClient drop-in: passed")

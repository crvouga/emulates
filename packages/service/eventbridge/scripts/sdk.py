"""Run with: uv run --with boto3==1.43.56 scripts/sdk.py http://127.0.0.1:12128"""
import json
import sys
import urllib.request
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

assert boto3.__version__ == "1.43.56"
endpoint = sys.argv[1].rstrip("/")
def admin(path, body):
    request = urllib.request.Request(endpoint + "/__admin/" + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request) as response:
        return json.load(response)

for name in ["fixture-a", "fixture-b"]:
    admin("state/rules", {"id": "default:" + name, "value": {"rule": {"Name": name, "Arn": "arn:aws:events:us-east-1:000000000000:rule/" + name}, "targets": [{"Id": "task", "Arn": "arn:aws:ecs:us-east-1:000000000000:cluster/fixture", "EcsParameters": {"TaskDefinitionArn": "arn:aws:ecs:us-east-1:000000000000:task-definition/fixture:1", "NetworkConfiguration": {"awsvpcConfiguration": {"Subnets": ["subnet-fixture"]}}}}]}})
client = boto3.client("events", endpoint_url=endpoint, region_name="us-east-1", aws_access_key_id="fixture", aws_secret_access_key="fixture", config=Config(retries={"max_attempts": 0}))
pages = list(client.get_paginator("list_rules").paginate(NamePrefix="fixture", PaginationConfig={"PageSize": 1}))
assert [r["Name"] for p in pages for r in p["Rules"]] == ["fixture-a", "fixture-b"]
assert len(pages) == 2 and "NextToken" not in pages[-1]
targets = client.list_targets_by_rule(Rule="fixture-a")["Targets"]
assert targets[0]["EcsParameters"]["NetworkConfiguration"]["awsvpcConfiguration"]["Subnets"] == ["subnet-fixture"]
try:
    client.list_targets_by_rule(Rule="missing")
    raise AssertionError("expected missing rule error")
except client.exceptions.ResourceNotFoundException:
    pass
admin("faults", {"preset": "access_denied", "count": 1})
try:
    client.list_rules()
    raise AssertionError("expected access denied")
except ClientError as error:
    assert error.response["Error"]["Code"] == "AccessDeniedException"
    assert error.response["ResponseMetadata"]["HTTPStatusCode"] == 403
print("boto3 1.43.56 EventBridge drop-in: passed")

"""Exact boto3 consumer drop-in. No AWS account or container is used."""
import json
import sys
import urllib.request
import boto3
from botocore.config import Config
assert boto3.__version__ == "1.43.56"
endpoint = sys.argv[1].rstrip("/")
client = boto3.client("ecs", endpoint_url=endpoint, region_name="us-east-1", aws_access_key_id="fixture", aws_secret_access_key="fixture", config=Config(retries={"max_attempts": 0}))
body = dict(cluster="default", taskDefinition="fixture", launchType="FARGATE", count=2, clientToken="fixture-token", networkConfiguration={"awsvpcConfiguration":{"subnets":["subnet-fixture"]}}, overrides={"containerOverrides":[{"name":"app","command":["echo","fixture"],"environment":[{"name":"MODE","value":"fixture"}]}]})
first = client.run_task(**body)
assert len(first["tasks"]) == 2 and first["failures"] == []
assert first["tasks"][0]["overrides"] == body["overrides"]
assert client.run_task(**body)["tasks"] == first["tasks"]
for changes, exception in [({"cluster":"missing"}, client.exceptions.ClusterNotFoundException), ({"count":1}, client.exceptions.ConflictException), ({"taskDefinition":"missing"}, client.exceptions.ClientException)]:
    try:
        client.run_task(**(body | changes))
        raise AssertionError("expected AWS error")
    except exception:
        pass
request = urllib.request.Request(endpoint+"/__admin/faults", data=json.dumps({"preset":"access_denied","count":1}).encode(), headers={"Content-Type":"application/json"})
urllib.request.urlopen(request).close()
try:
    client.run_task(**body)
    raise AssertionError("expected access denied")
except client.exceptions.AccessDeniedException as error:
    assert error.response["ResponseMetadata"]["HTTPStatusCode"] == 400
print("boto3 1.43.56 ECS drop-in: passed")

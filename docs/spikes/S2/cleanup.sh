#!/usr/bin/env bash
# Remove everything spikes S2/S3/S4 started (never touches other containers).
podman rm -f s2-jserver s2-caddy s3-headless >/dev/null 2>&1
podman network rm s2net s3back >/dev/null 2>&1
podman volume rm s3data >/dev/null 2>&1
podman rmi localhost/s3-headless:3.7.1 >/dev/null 2>&1
echo cleaned

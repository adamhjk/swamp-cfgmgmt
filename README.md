# Swamp Cfg Mgmt

SSH-based configuration management for [Swamp](https://github.com/systeminit/swamp). Manage remote Linux and macOS systems using the check/apply pattern — every model is idempotent and reports whether resources are compliant, non-compliant, applied, or failed.

## What's in the box

36 model types covering the full stack of OS configuration:

| Category | Models |
| --- | --- |
| **System info** | `node` |
| **Files** | `file`, `template`, `directory`, `link`, `line`, `copy_file`, `fetch`, `archive` |
| **Packages** | `apt`, `dnf`, `pacman`, `homebrew`, `apt_repository`, `dnf_repository` |
| **Services** | `systemd` |
| **Users & groups** | `user`, `group`, `authorized_key` |
| **Networking** | `host_entry`, `firewall`, `certificate` |
| **System** | `hostname`, `timezone`, `sysctl`, `kernel_module`, `cron`, `mount`, `selinux`, `reboot` |
| **Commands** | `exec`, `debug_exec`, `debug_file` |
| **Docker** | `docker_image`, `docker_container` |
| **Source control** | `git` |

Every model is a factory across hosts — a single definition can target multiple hosts via workflow `forEach`, with per-host data stored separately.

## Getting started

### Prerequisites

- [Swamp](https://github.com/systeminit/swamp) installed
- SSH access to target hosts
- [Deno](https://deno.land/) (for development/testing only)

### Install the extension

```bash
swamp extension install @adam/cfgmgmt
```

### Example: gather node facts

```bash
swamp model create @adam/cfgmgmt/node my-node --arg host=192.168.1.10 --arg user=root
swamp model run my-node check
swamp model get my-node --json
```

### Example: deploy a file

```bash
swamp model create @adam/cfgmgmt/file my-config \
  --arg host=192.168.1.10 \
  --arg user=root \
  --arg path=/etc/myapp.conf \
  --arg content="key=value"
swamp model run my-config apply
```

## How it works

All models follow the **check/apply** pattern:

- **check** — inspects the remote system and reports `compliant` or `non-compliant` without making changes
- **apply** — converges the resource to the desired state, reporting `applied` or `failed`

Connections are multiplexed via OpenSSH ControlMaster sockets. All models (except `node` and `homebrew`) support sudo privilege escalation.

The remote system requires no dependencies other than a bash-compatible shell.

## Development

Extension code lives in `extensions/` and tests in `tests/`, managed with Deno.

```bash
deno task fmt:check   # Format check
deno task fmt         # Auto-format
deno task lint        # Lint
deno task test        # Run tests (requires SSH connectivity to test nodes)
```

## License

Swamp Cfg Mgmt is licensed under the [GNU Affero General Public License v3.0](COPYING). See [COPYRIGHT](COPYRIGHT) for details.

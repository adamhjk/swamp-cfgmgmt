# cfgmgmt — SSH-based configuration management

The `@cfgmgmt/*` extension models manage remote Linux and macOS systems over SSH.
Every model follows the **check/apply** pattern:

- **check** — inspect the remote system and report whether the resource is already in the desired state (dry-run, no changes made).
- **apply** — converge the resource to the desired state, only making the changes that `check` would have reported.

Both methods are idempotent. Running `apply` twice in a row produces no changes on the second run.

## Status values

Every model writes a `status` field to its output. The four possible values are:

| Status | Meaning |
|---|---|
| `compliant` | Resource already matches the desired state — nothing to do |
| `non_compliant` | Resource differs from the desired state (returned by `check`) |
| `applied` | Changes were made and the resource now matches the desired state |
| `failed` | An error occurred — see the `error` field for details |

## SSH connection

All models (except `@cfgmgmt/node`, which uses its own field names) share these connection fields:

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `nodeHost` | string | — | yes | Hostname or IP of the remote node |
| `nodeUser` | string | `"root"` | no | SSH username |
| `nodePort` | number | `22` | no | SSH port |
| `nodeIdentityFile` | string | — | no | Path to SSH private key |

Connections are multiplexed via OpenSSH `ControlMaster` sockets, so multiple models targeting the same host reuse a single SSH connection.

## Multi-host factory pattern

Every cfgmgmt model is a **factory across hosts**. A single model definition (e.g. `nginx-config`) can target multiple hosts, with each host's data stored under a separate instance name keyed by the host identifier.

For most models, the instance name is `g.nodeHost` (the value of the `nodeHost` global argument). For `@cfgmgmt/node`, it is `g.hostname`.

This means:
- `data.latest("nginx-config", "192.168.1.50")` — gets the state for one specific host
- `data.findBySpec("nginx-config", "state")` — gets states for ALL hosts that model has been run against

### Model inputs schema for connection fields

To use a model across multiple hosts, declare the connection fields as runtime `inputs` and reference them with `${{ inputs.* }}` in `globalArguments`. This lets workflows (or `--input` on the CLI) provide per-host values:

```yaml
type: "@cfgmgmt/dnf"
name: nginx-pkg
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  packages: [nginx]
  ensure: present
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

For `@cfgmgmt/node`, the equivalent fields are `hostname` and `sshIdentityFile`:

```yaml
type: "@cfgmgmt/node"
name: webserver
inputs:
  properties:
    hostname:
      type: string
    sshIdentityFile:
      type: string
  required: [hostname, sshIdentityFile]
globalArguments:
  hostname: ${{ inputs.hostname }}
  sshUser: deploy
  sshIdentityFile: ${{ inputs.sshIdentityFile }}
```

### forEach in workflows

A workflow step uses `forEach` to iterate over hosts and passes per-host values via `task.inputs`:

```yaml
steps:
  - name: install-${{ self.host }}
    forEach:
      item: host
      in: ${{ inputs.hosts }}
    task:
      type: model_method
      modelIdOrName: nginx-pkg
      methodName: apply
      inputs:
        nodeHost: ${{ self.host }}
        nodeIdentityFile: /path/to/key.pem
```

After running, `swamp data list nginx-pkg` shows separate data entries per host instead of a single `"state"` entry.

## Privilege escalation (become)

All models except `@cfgmgmt/node` and `@cfgmgmt/homebrew` support privilege escalation via `sudo`:

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `become` | boolean | `false` | no | Enable `sudo` privilege escalation |
| `becomeUser` | string | `"root"` | no | User to become (passed to `sudo -u`) |
| `becomePassword` | string | — | no | Password for `sudo -S` (marked sensitive — stored encrypted in vault) |

When `become: true`, all remote commands are wrapped with `sudo`. If `becomePassword` is set, the password is piped to `sudo -S`; otherwise `sudo -n` (passwordless) is used.

`@cfgmgmt/node` does not support `become` — it connects as the SSH user directly.
`@cfgmgmt/homebrew` accepts the `become` fields in its schema but does not use them — Homebrew forbids running as root.

---

## @cfgmgmt/node

Gather system facts from a remote node.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `hostname` | string | — | yes | Hostname or IP of the remote node |
| `sshUser` | string | `"root"` | no | SSH username |
| `sshPort` | number | `22` | no | SSH port |
| `sshIdentityFile` | string | — | no | Path to SSH private key |

> **Note:** This model uses `hostname`/`sshUser`/`sshPort`/`sshIdentityFile` — not the `nodeHost`/`nodeUser` convention used by other cfgmgmt models.

### Methods

| Method | Description |
|---|---|
| `gather` | SSH to the node and collect system facts |

### Output — `info`

| Field | Type | Description |
|---|---|---|
| `hostname` | string | System hostname (from `hostname` command) |
| `os` | string | OS identifier (e.g. `fedora`, `ubuntu`, `arch`) |
| `osVersion` | string | OS version (e.g. `41`, `24.04`) |
| `arch` | string | CPU architecture (e.g. `x86_64`, `aarch64`) |
| `kernel` | string | Kernel version |
| `packageManagers` | string[] | Detected package managers (`pacman`, `apt`, `dnf`, `yum`, `homebrew`, `nix`, `zypper`, `apk`) |
| `gatheredAt` | string | ISO 8601 timestamp of when facts were gathered |

### Example — single host

```yaml
type: "@cfgmgmt/node"
name: webserver
globalArguments:
  hostname: "192.168.1.50"
  sshUser: deploy
  sshIdentityFile: /home/deploy/.ssh/id_ed25519
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/node"
name: webserver
inputs:
  properties:
    hostname:
      type: string
    sshIdentityFile:
      type: string
  required: [hostname, sshIdentityFile]
globalArguments:
  hostname: ${{ inputs.hostname }}
  sshUser: deploy
  sshIdentityFile: ${{ inputs.sshIdentityFile }}
```

---

## @cfgmgmt/file

Manage files on a remote node — create, update content, set ownership/permissions, or remove.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `path` | string | — | yes | Absolute path of the file on the remote node |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `content` | string | — | no | Desired file content (only when `ensure: present`) |
| `owner` | string | — | no | File owner |
| `group` | string | — | no | File group |
| `mode` | string | — | no | File permissions in octal (e.g. `"0644"`) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if the file matches the desired state (dry-run) |
| `apply` | Create/update/remove the file to match the desired state |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `path` | string | File path |
| `ensure` | string | `"present"` or `"absent"` |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.exists` | boolean | Whether the file currently exists |
| `current.isFile` | boolean | Whether the path is a regular file |
| `current.owner` | string? | Current file owner |
| `current.group` | string? | Current file group |
| `current.mode` | string? | Current permissions (e.g. `"0644"`) |
| `current.contentSha256` | string? | SHA-256 hash of current content |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/file"
name: nginx-config
globalArguments:
  path: /etc/nginx/nginx.conf
  ensure: present
  content: |
    worker_processes auto;
    events { worker_connections 1024; }
    http {
      include /etc/nginx/conf.d/*.conf;
    }
  owner: root
  group: root
  mode: "0644"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/file"
name: nginx-config
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  path: /etc/nginx/nginx.conf
  ensure: present
  content: |
    worker_processes auto;
    events { worker_connections 1024; }
    http {
      include /etc/nginx/conf.d/*.conf;
    }
  owner: root
  group: root
  mode: "0644"
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

---

## @cfgmgmt/template

Render an EJS template with variables and deploy the result to a remote node — create, update, set ownership/permissions, or remove.

EJS's default HTML escaping is disabled (`<%= var %>` does plain string interpolation), since this model generates config files, not HTML.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `path` | string | — | yes | Absolute path of the file on the remote node |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `template` | string | — | no | EJS template string (only when `ensure: present`) |
| `variables` | object | `{}` | no | Key-value map passed to the EJS template |
| `owner` | string | — | no | File owner |
| `group` | string | — | no | File group |
| `mode` | string | — | no | File permissions in octal (e.g. `"0644"`) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Render template and check if the result matches the remote file (dry-run) |
| `apply` | Render template and create/update/remove the file to match |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `path` | string | File path |
| `ensure` | string | `"present"` or `"absent"` |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.exists` | boolean | Whether the file currently exists |
| `current.isFile` | boolean | Whether the path is a regular file |
| `current.owner` | string? | Current file owner |
| `current.group` | string? | Current file group |
| `current.mode` | string? | Current permissions (e.g. `"0644"`) |
| `current.contentSha256` | string? | SHA-256 hash of current content |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### EJS syntax

| Syntax | Meaning |
|---|---|
| `<%= expr %>` | Output the value (no HTML escaping — plain interpolation) |
| `<% code %>` | Execute JavaScript (loops, conditionals) |
| `<%# comment %>` | Comment (not included in output) |
| `<%_ code %>` | Same as `<% %>` but strips all leading whitespace before the tag |
| `<% code -%>` | Strip the newline after the tag |
| `<% code _%>` | Strip all trailing whitespace after the tag |

#### Whitespace control

Control tags like `<% for (...) { %>` occupy a line by themselves, which leaves a blank line in the output. Use the `-%>` closing to eat that newline:

```
<% for (const upstream of upstreams) { -%>
upstream <%= upstream %>;
<% } -%>
```

Without `-%>`, the output would have blank lines around each `upstream` line. With it:

```
upstream 10.0.1.10:8080;
upstream 10.0.1.11:8080;
```

You can combine leading and trailing whitespace stripping in the same tag — `<%_` on the open side and `-%>` or `_%>` on the close side. Use `-%>` (strip newline) for most cases; use `_%>` (strip all trailing whitespace) when you need to collapse indentation too.

### Example — single host

```yaml
type: "@cfgmgmt/template"
name: nginx-site-config
globalArguments:
  path: /etc/nginx/conf.d/mysite.conf
  ensure: present
  template: |
    server {
        listen <%= port %>;
        server_name <%= hostname %>;
        <% for (const upstream of upstreams) { %>
        location /api {
            proxy_pass http://<%= upstream %>;
        }
        <% } %>
    }
  variables:
    port: 8080
    hostname: web1.example.com
    upstreams:
      - 10.0.1.10:8080
      - 10.0.1.11:8080
  owner: root
  group: root
  mode: "0644"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — with CEL data wiring

```yaml
type: "@cfgmgmt/template"
name: nginx-site-config
globalArguments:
  path: /etc/nginx/conf.d/mysite.conf
  ensure: present
  template: |
    server {
        listen <%= port %>;
        server_name <%= hostname %>;
    }
  variables:
    port: ${{ data.latest("app-config", self.nodeHost).attributes.port }}
    hostname: ${{ data.latest("node", self.nodeHost).attributes.fqdn }}
  owner: root
  group: root
  mode: "0644"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/directory

Manage directories on a remote node — create with ownership/permissions, or remove.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `path` | string | — | yes | Absolute path of the directory |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `owner` | string | — | no | Directory owner |
| `group` | string | — | no | Directory group |
| `mode` | string | — | no | Directory permissions in octal (e.g. `"0755"`) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if the directory matches the desired state (dry-run) |
| `apply` | Create/remove the directory to match the desired state |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `path` | string | Directory path |
| `ensure` | string | `"present"` or `"absent"` |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.exists` | boolean | Whether the directory currently exists |
| `current.isDirectory` | boolean | Whether the path is a directory |
| `current.owner` | string? | Current owner |
| `current.group` | string? | Current group |
| `current.mode` | string? | Current permissions |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/directory"
name: app-dirs
globalArguments:
  path: /var/www/myapp
  ensure: present
  owner: www-data
  group: www-data
  mode: "0755"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/directory"
name: app-dirs
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  path: /var/www/myapp
  ensure: present
  owner: www-data
  group: www-data
  mode: "0755"
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

---

## @cfgmgmt/link

Manage symbolic links on a remote node.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `path` | string | — | yes | Path where the symlink should exist |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `target` | string | — | no | Target the symlink should point to (required when `ensure: present`) |
| `owner` | string | — | no | Symlink owner |
| `group` | string | — | no | Symlink group |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if the symlink matches the desired state (dry-run) |
| `apply` | Create/update/remove the symlink to match the desired state |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `path` | string | Symlink path |
| `ensure` | string | `"present"` or `"absent"` |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.exists` | boolean | Whether something exists at the path |
| `current.isLink` | boolean | Whether the path is a symbolic link |
| `current.linkTarget` | string? | Current symlink target |
| `current.owner` | string? | Current owner |
| `current.group` | string? | Current group |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/link"
name: current-release
globalArguments:
  path: /var/www/myapp/current
  ensure: present
  target: /var/www/myapp/releases/v2.1.0
  owner: www-data
  group: www-data
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/link"
name: current-release
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  path: /var/www/myapp/current
  ensure: present
  target: /var/www/myapp/releases/v2.1.0
  owner: www-data
  group: www-data
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

---

## @cfgmgmt/exec

Run an arbitrary command on a remote node with optional guard conditions.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `command` | string | — | yes | The command to execute |
| `onlyIf` | string | — | no | Guard: only run if this command exits 0 |
| `notIf` | string | — | no | Guard: skip if this command exits 0 |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

The `onlyIf` and `notIf` guards make `exec` idempotent. If the guard skips the command, the status is `compliant`. Both guards are evaluated with `become` if enabled.

### Methods

| Method | Description |
|---|---|
| `check` | Evaluate guards and report whether the command would run (does not execute it) |
| `apply` | Evaluate guards and execute the command if they pass |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `command` | string | The command that was (or would be) executed |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `stdout` | string | Standard output from the command |
| `stderr` | string | Standard error from the command |
| `exitCode` | number | Exit code of the command |
| `changes` | string[] | List of changes (contains the command if it ran) |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/exec"
name: reload-nginx
globalArguments:
  command: "nginx -s reload"
  onlyIf: "nginx -t"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/exec"
name: reload-nginx
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  command: "nginx -s reload"
  onlyIf: "nginx -t"
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

---

## @cfgmgmt/systemd

Manage systemd services — enable/disable, start/stop, deploy unit files, restart, and fetch logs.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `service` | string | — | yes | Service name (e.g. `nginx` or `nginx.service`) |
| `ensure` | enum | — | no | `"running"` or `"stopped"` |
| `enabled` | boolean | — | no | Whether the service should be enabled at boot |
| `unitFile` | string | — | no | Full content of a systemd unit file to deploy to `/etc/systemd/system/` |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

When `unitFile` is provided, `apply` writes it to `/etc/systemd/system/<service>` (appending `.service` if the name has no suffix) and runs `systemctl daemon-reload`.

### Methods

| Method | Description |
|---|---|
| `check` | Check if the service matches the desired state (dry-run) |
| `apply` | Converge service state — deploy unit file, enable/disable, start/stop |
| `restart` | Restart the service (imperative — always runs, does not check first) |
| `logs` | Fetch recent journal logs for the service |

The `logs` method accepts one argument:

| Argument | Type | Default | Description |
|---|---|---|---|
| `lines` | number | `100` | Number of journal lines to fetch |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `service` | string | Service name |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.loaded` | boolean | Whether the unit is loaded |
| `current.active` | string | Active state (e.g. `active`, `inactive`, `failed`) |
| `current.enabled` | string | Unit file state (e.g. `enabled`, `disabled`) |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Output — `logs`

| Field | Type | Description |
|---|---|---|
| `service` | string | Service name |
| `output` | string | Journal log output |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/systemd"
name: nginx-service
globalArguments:
  service: nginx
  ensure: running
  enabled: true
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/systemd"
name: nginx-service
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  service: nginx
  ensure: running
  enabled: true
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

---

## @cfgmgmt/dnf

Manage packages on Fedora/RHEL systems using `dnf`.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `packages` | string[] | `[]` | no | Package names to manage |
| `ensure` | enum | `"present"` | no | `"present"` to install, `"absent"` to remove |
| `version` | string | — | no | Pin to a specific package version (e.g. `1.24.0-1.el9`). Applies to all packages in the list. |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if packages match the desired state without modifying |
| `apply` | Install or remove packages to match the desired state |
| `refresh` | Refresh the dnf package metadata (`dnf makecache`) |
| `upgrade` | Upgrade all installed packages (`dnf upgrade -y`) |
| `list` | List all installed packages (writes to the `installed` resource) |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `packages` | object[]? | Per-package status: `name`, `installed` (boolean), `version` |
| `changes` | string[] | List of changes (e.g. `"install nginx"`) |
| `stdout` | string | Command output |
| `stderr` | string | Command error output |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Output — `installed`

| Field | Type | Description |
|---|---|---|
| `packages` | object[] | All installed packages: `name`, `version` |
| `count` | number | Total number of installed packages |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/dnf"
name: web-packages
globalArguments:
  packages:
    - nginx
    - certbot
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/dnf"
name: web-packages
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  packages:
    - nginx
    - certbot
  ensure: present
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

---

## @cfgmgmt/apt

Manage packages on Debian/Ubuntu systems using `apt`.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `packages` | string[] | `[]` | no | Package names to manage |
| `ensure` | enum | `"present"` | no | `"present"` to install, `"absent"` to remove |
| `version` | string | — | no | Pin to a specific package version (e.g. `1.24.0-1ubuntu1`). Applies to all packages in the list. |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if packages match the desired state without modifying |
| `apply` | Install or remove packages to match the desired state |
| `refresh` | Update the apt package database (`apt-get update`) |
| `upgrade` | Upgrade all installed packages (`apt-get upgrade -y`) |
| `list` | List all installed packages (writes to the `installed` resource) |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `packages` | object[]? | Per-package status: `name`, `installed` (boolean), `version` |
| `changes` | string[] | List of changes (e.g. `"install nginx"`) |
| `stdout` | string | Command output |
| `stderr` | string | Command error output |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Output — `installed`

| Field | Type | Description |
|---|---|---|
| `packages` | object[] | All installed packages: `name`, `version` |
| `count` | number | Total number of installed packages |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/apt"
name: web-packages
globalArguments:
  packages:
    - nginx
    - certbot
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/apt"
name: web-packages
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  packages:
    - nginx
    - certbot
  ensure: present
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

---

## @cfgmgmt/pacman

Manage packages on Arch Linux systems using `pacman`.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `packages` | string[] | `[]` | no | Package names to manage |
| `ensure` | enum | `"present"` | no | `"present"` to install, `"absent"` to remove |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if packages match the desired state without modifying |
| `apply` | Install or remove packages to match the desired state |
| `refresh` | Update the pacman package database (`pacman -Sy`) |
| `upgrade` | Upgrade all installed packages (`pacman -Syu --noconfirm`) |
| `list` | List all installed packages (writes to the `installed` resource) |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `packages` | object[]? | Per-package status: `name`, `installed` (boolean), `version` |
| `changes` | string[] | List of changes (e.g. `"install nginx"`) |
| `stdout` | string | Command output |
| `stderr` | string | Command error output |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Output — `installed`

| Field | Type | Description |
|---|---|---|
| `packages` | object[] | All installed packages: `name`, `version` |
| `count` | number | Total number of installed packages |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/pacman"
name: web-packages
globalArguments:
  packages:
    - nginx
    - certbot
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/pacman"
name: web-packages
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  packages:
    - nginx
    - certbot
  ensure: present
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

---

## @cfgmgmt/homebrew

Manage packages on macOS using Homebrew.

> **Note:** Homebrew forbids running as root. The `become` fields are accepted in the schema but ignored — all commands run as the SSH user directly.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `packages` | string[] | `[]` | no | Formula names to manage |
| `ensure` | enum | `"present"` | no | `"present"` to install, `"absent"` to remove |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| `become` | boolean | `false` | no | Accepted but ignored (brew forbids root) |
| `becomeUser` | string | `"root"` | no | Accepted but ignored |
| `becomePassword` | string | — | no | Accepted but ignored |

### Methods

| Method | Description |
|---|---|
| `check` | Check if packages match the desired state without modifying |
| `apply` | Install or remove packages to match the desired state |
| `refresh` | Update the Homebrew package database (`brew update`) |
| `upgrade` | Upgrade all installed packages (`brew upgrade`) |
| `list` | List all installed formulae (writes to the `installed` resource) |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `packages` | object[]? | Per-package status: `name`, `installed` (boolean), `version` |
| `changes` | string[] | List of changes (e.g. `"install jq"`) |
| `stdout` | string | Command output |
| `stderr` | string | Command error output |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Output — `installed`

| Field | Type | Description |
|---|---|---|
| `packages` | object[] | All installed packages: `name`, `version` |
| `count` | number | Total number of installed packages |
| `timestamp` | string | ISO 8601 timestamp |

### Example — single host

```yaml
type: "@cfgmgmt/homebrew"
name: dev-tools
globalArguments:
  packages:
    - jq
    - ripgrep
  ensure: present
  nodeHost: "192.168.1.100"
  nodeUser: adam
```

### Example — multi-host (with inputs)

```yaml
type: "@cfgmgmt/homebrew"
name: dev-tools
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  packages:
    - jq
    - ripgrep
  ensure: present
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: adam
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
```

---

## @cfgmgmt/hostname

Set the system hostname on a remote node.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `name` | string | — | yes | Desired system hostname |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if hostname matches desired state (dry-run) |
| `apply` | Set the system hostname to the desired value |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `name` | string | Desired hostname |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.hostname` | string? | Current live hostname |
| `current.etcHostname` | string? | Current contents of /etc/hostname |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

Uses `hostnamectl set-hostname` on systemd systems, falls back to writing `/etc/hostname` + `hostname` command.

### Example

```yaml
type: "@cfgmgmt/hostname"
name: set-hostname
globalArguments:
  name: web-01.example.com
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/timezone

Set the system timezone on a remote node.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `timezone` | string | — | yes | IANA timezone (e.g. `"America/New_York"`) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if timezone matches desired state (dry-run) |
| `apply` | Set the system timezone to the desired value |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `timezone` | string | Desired timezone |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.timezone` | string? | Current timezone |
| `current.utcOffset` | string? | Current UTC offset |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

Validates the timezone exists in `/usr/share/zoneinfo/`. Uses `timedatectl` on systemd systems, falls back to symlink `/etc/localtime` + writing `/etc/timezone`.

### Example

```yaml
type: "@cfgmgmt/timezone"
name: set-tz
globalArguments:
  timezone: America/New_York
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/user

Manage system users — create, modify, or remove.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `username` | string | — | yes | Username to manage |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `uid` | number | — | no | Desired UID |
| `gid` | number | — | no | Desired primary GID |
| `groups` | string[] | — | no | Supplementary groups |
| `home` | string | — | no | Home directory path |
| `shell` | string | — | no | Login shell |
| `system` | boolean | — | no | Create as system user |
| `managehome` | boolean | `false` | no | Manage home directory (create/remove) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if user matches desired state (dry-run) |
| `apply` | Create, modify, or remove a system user |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `username` | string | Username |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.exists` | boolean | Whether the user exists |
| `current.uid` | number? | Current UID |
| `current.gid` | number? | Current primary GID |
| `current.groups` | string[] | Current supplementary groups |
| `current.home` | string? | Current home directory |
| `current.shell` | string? | Current login shell |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/user"
name: deploy-user
globalArguments:
  username: deploy
  ensure: present
  shell: /bin/bash
  groups: [sudo, docker]
  managehome: true
  nodeHost: "192.168.1.50"
  nodeUser: root
  become: true
```

---

## @cfgmgmt/group

Manage system groups — create, modify membership, or remove.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `groupname` | string | — | yes | Group name to manage |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `gid` | number | — | no | Desired GID |
| `members` | string[] | — | no | Group members (replaces all supplementary members) |
| `system` | boolean | — | no | Create as system group |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if group matches desired state (dry-run) |
| `apply` | Create, modify, or remove a system group |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `groupname` | string | Group name |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.exists` | boolean | Whether the group exists |
| `current.gid` | number? | Current GID |
| `current.members` | string[] | Current group members |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

> **Note:** `getent group` only shows supplementary members — users with this group as their primary group are not listed in `members`.

### Example

```yaml
type: "@cfgmgmt/group"
name: app-group
globalArguments:
  groupname: appusers
  ensure: present
  members: [deploy, www-data]
  nodeHost: "192.168.1.50"
  nodeUser: root
  become: true
```

---

## @cfgmgmt/authorized_key

Manage SSH authorized keys for a user.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `user` | string | — | yes | User whose authorized_keys file to manage |
| `key` | string | — | yes | Full SSH public key line |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if key is in the authorized_keys file (dry-run) |
| `apply` | Add or remove a key from the authorized_keys file |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `user` | string | Target user |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.fileExists` | boolean | Whether the authorized_keys file exists |
| `current.keyPresent` | boolean | Whether the key is in the file |
| `current.authorizedKeysPath` | string? | Path to the authorized_keys file |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

Keys are matched by their base64 body (second field), so comments can differ without causing re-application.

### Example

```yaml
type: "@cfgmgmt/authorized_key"
name: deploy-key
globalArguments:
  user: deploy
  key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample deploy@workstation"
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: root
  become: true
```

---

## @cfgmgmt/host_entry

Manage entries in `/etc/hosts`.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `hostname` | string | — | yes | Primary hostname for the entry |
| `ip` | string | — | yes | IP address |
| `aliases` | string[] | — | no | Additional hostname aliases |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if /etc/hosts entry matches desired state (dry-run) |
| `apply` | Add, update, or remove an /etc/hosts entry |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `hostname` | string | Primary hostname |
| `ip` | string | IP address |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.entryExists` | boolean | Whether a matching entry exists |
| `current.currentIp` | string? | Current IP for the hostname |
| `current.currentAliases` | string[] | Current aliases |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

Uses a read-modify-write pattern to preserve other entries and comments.

### Example

```yaml
type: "@cfgmgmt/host_entry"
name: db-host
globalArguments:
  hostname: db.internal
  ip: "10.0.0.5"
  aliases: [database, postgres]
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/sysctl

Manage kernel parameters via sysctl, with persistence.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `key` | string | — | yes | Sysctl key (e.g. `net.ipv4.ip_forward`) |
| `value` | string | — | yes | Desired value |
| `ensure` | enum | `"present"` | no | `"present"` or `"absent"` |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if sysctl parameter matches desired state (dry-run) |
| `apply` | Set or remove a sysctl kernel parameter |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `key` | string | Sysctl key |
| `value` | string | Desired value |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.liveValue` | string? | Current live kernel value |
| `current.persisted` | boolean | Whether a persistence file exists |
| `current.persistedValue` | string? | Value in persistence file |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

Persistence files are written to `/etc/sysctl.d/99-cfgmgmt-{key}.conf`. The `present` action both sets the live value and writes the persistence file. The `absent` action removes the persistence file and reloads sysctl.

### Example

```yaml
type: "@cfgmgmt/sysctl"
name: ip-forward
globalArguments:
  key: net.ipv4.ip_forward
  value: "1"
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/cron

Manage cron jobs with marker-based idempotency.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `name` | string | — | yes | Unique identifier for this cron job |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `command` | string | — | yes | Command to run |
| `user` | string | `"root"` | no | User whose crontab to manage |
| `minute` | string | `"*"` | no | Minute (0-59 or *) |
| `hour` | string | `"*"` | no | Hour (0-23 or *) |
| `day` | string | `"*"` | no | Day of month (1-31 or *) |
| `month` | string | `"*"` | no | Month (1-12 or *) |
| `weekday` | string | `"*"` | no | Day of week (0-7 or *) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if cron job matches desired state (dry-run) |
| `apply` | Add, update, or remove a cron job |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `name` | string | Cron job identifier |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.entryExists` | boolean | Whether the cron entry exists |
| `current.schedule` | string? | Current schedule |
| `current.command` | string? | Current command |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

Each cron entry is preceded by a `# cfgmgmt:NAME` marker comment for idempotent identification.

### Example

```yaml
type: "@cfgmgmt/cron"
name: backup-job
globalArguments:
  name: daily-backup
  ensure: present
  command: /usr/local/bin/backup.sh
  minute: "0"
  hour: "2"
  user: root
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/mount

Manage filesystem mounts and `/etc/fstab` entries.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `path` | string | — | yes | Mount point path |
| `device` | string | — | yes | Device or remote filesystem to mount |
| `fstype` | string | — | yes | Filesystem type (e.g. `ext4`, `nfs`, `tmpfs`) |
| `options` | string | `"defaults"` | no | Mount options |
| `ensure` | enum | — | yes | `"mounted"`, `"unmounted"`, `"present"`, or `"absent"` |
| `dump` | number | `0` | no | fstab dump field |
| `pass` | number | `0` | no | fstab pass field |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

**ensure semantics:**
- `mounted` — ensure fstab entry exists and filesystem is mounted
- `unmounted` — ensure fstab entry exists but filesystem is not mounted
- `present` — ensure fstab entry exists (don't touch mount state)
- `absent` — remove fstab entry and unmount if mounted

### Methods

| Method | Description |
|---|---|
| `check` | Check if mount matches desired state (dry-run) |
| `apply` | Manage filesystem mount and fstab entry |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `path` | string | Mount point path |
| `ensure` | string | Desired mount state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.mounted` | boolean | Whether currently mounted |
| `current.mountDevice` | string? | Device of active mount |
| `current.mountFstype` | string? | Filesystem type of active mount |
| `current.mountOptions` | string? | Options of active mount |
| `current.fstabPresent` | boolean | Whether entry exists in fstab |
| `current.fstabDevice` | string? | Device in fstab |
| `current.fstabFstype` | string? | Filesystem type in fstab |
| `current.fstabOptions` | string? | Options in fstab |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/mount"
name: data-volume
globalArguments:
  path: /mnt/data
  device: /dev/sdb1
  fstype: ext4
  options: defaults,noatime
  ensure: mounted
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/firewall

Manage firewall rules with auto-detection of the backend (ufw, firewalld, or iptables).

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `port` | number | — | yes | Port number |
| `protocol` | enum | `"tcp"` | no | `"tcp"` or `"udp"` |
| `action` | enum | — | yes | `"allow"`, `"deny"`, or `"reject"` |
| `direction` | enum | `"in"` | no | `"in"` or `"out"` |
| `source` | string | — | no | Source CIDR (e.g. `10.0.0.0/8`) |
| `ensure` | enum | `"present"` | no | `"present"` or `"absent"` |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if firewall rule matches desired state (dry-run) |
| `apply` | Add or remove a firewall rule |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `port` | number | Port number |
| `protocol` | string | Protocol |
| `action` | string | Firewall action |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.backend` | string? | Detected backend (ufw, firewalld, iptables) |
| `current.ruleExists` | boolean | Whether the rule exists |
| `current.ruleDetails` | string? | Details of the matched rule |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

> **Note:** iptables rules are not persistent across reboots. Use ufw or firewalld for persistent rules.

### Example

```yaml
type: "@cfgmgmt/firewall"
name: allow-http
globalArguments:
  port: 80
  protocol: tcp
  action: allow
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/selinux

Manage SELinux mode or boolean values.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `mode` | enum | — | no | `"enforcing"`, `"permissive"`, or `"disabled"` (mutually exclusive with `boolean`) |
| `boolean` | string | — | no | SELinux boolean name (mutually exclusive with `mode`) |
| `booleanValue` | enum | — | no | `"on"` or `"off"` (required when `boolean` is set) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

Either `mode` or `boolean`+`booleanValue` must be specified, not both.

### Methods

| Method | Description |
|---|---|
| `check` | Check if SELinux matches desired state (dry-run) |
| `apply` | Set SELinux mode or boolean value |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.selinuxInstalled` | boolean | Whether SELinux is installed |
| `current.currentMode` | string? | Current live SELinux mode |
| `current.configMode` | string? | Configured mode in /etc/selinux/config |
| `current.booleanCurrent` | string? | Current boolean value |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

> **Note:** Switching between `disabled` and `enforcing`/`permissive` requires a reboot. `setsebool -P` can be slow as it recompiles the SELinux policy.

### Example

```yaml
type: "@cfgmgmt/selinux"
name: selinux-mode
globalArguments:
  mode: enforcing
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/docker_image

Manage Docker images on a remote node — pull, remove, or prune.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `image` | string | — | yes | Docker image with tag (e.g. `nginx:1.25`) |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `force` | boolean | `false` | no | Force pull even if image already present |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if Docker image matches desired state (dry-run) |
| `apply` | Pull or remove a Docker image |
| `prune` | Remove dangling images (imperative, always runs) |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `image` | string | Docker image name |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.imageExists` | boolean | Whether the image exists locally |
| `current.imageId` | string? | Image ID |
| `current.tags` | string[] | Image tags |
| `current.created` | string? | Image creation timestamp |
| `current.size` | number? | Image size in bytes |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/docker_image"
name: nginx-image
globalArguments:
  image: "nginx:1.25"
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/docker_container

Manage Docker containers — create, start, stop, remove, and detect configuration drift.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `name` | string | — | yes | Container name |
| `image` | string | — | yes | Docker image (e.g. `nginx:1.25`) |
| `ensure` | enum | — | yes | `"running"`, `"stopped"`, or `"absent"` |
| `ports` | string[] | — | no | Port mappings (e.g. `["8080:80"]`) |
| `environment` | string[] | — | no | Environment variables (e.g. `["FOO=bar"]`) |
| `volumes` | string[] | — | no | Volume mounts (e.g. `["/host:/container"]`) |
| `restart` | enum | — | no | `"no"`, `"always"`, `"unless-stopped"`, or `"on-failure"` |
| `command` | string | — | no | Override container command |
| `network` | string | — | no | Docker network to connect to |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

When configuration drift is detected (image, ports, environment, volumes, or restart policy changed), the container is recreated (stop → remove → create → start).

### Methods

| Method | Description |
|---|---|
| `check` | Check if container matches desired state (dry-run) |
| `apply` | Create, start, stop, or remove a Docker container |
| `logs` | Fetch recent container logs |
| `restart` | Restart the container (imperative, always runs) |

The `logs` method accepts one argument:

| Argument | Type | Default | Description |
|---|---|---|---|
| `lines` | number | `100` | Number of log lines to fetch |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `name` | string | Container name |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.containerExists` | boolean | Whether the container exists |
| `current.containerStatus` | string? | Container status (running, exited, etc.) |
| `current.imageId` | string? | Current image ID |
| `current.currentImage` | string? | Current image name |
| `current.ports` | string[] | Current port mappings |
| `current.env` | string[] | Current environment variables |
| `current.volumes` | string[] | Current volume mounts |
| `current.restartPolicy` | string? | Current restart policy |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Output — `logs`

| Field | Type | Description |
|---|---|---|
| `name` | string | Container name |
| `output` | string | Container log output |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/docker_container"
name: web-app
globalArguments:
  name: webapp
  image: "myapp:latest"
  ensure: running
  ports: ["8080:80"]
  environment: ["NODE_ENV=production"]
  volumes: ["/data/app:/app/data"]
  restart: unless-stopped
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/git

Manage git repository checkouts on a remote node.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `path` | string | — | yes | Local path for the repository |
| `repo` | string | — | yes | Git repository URL |
| `revision` | string | `"HEAD"` | no | Branch, tag, or commit hash |
| `ensure` | enum | — | yes | `"present"` or `"absent"` |
| `depth` | number | — | no | Shallow clone depth |
| `owner` | string | — | no | Repository owner |
| `group` | string | — | no | Repository group |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if git repository matches desired state (dry-run) |
| `apply` | Clone, update, or remove a git repository |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `path` | string | Repository path |
| `repo` | string | Repository URL |
| `ensure` | string | Desired state |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.exists` | boolean | Whether the path exists |
| `current.isGitRepo` | boolean | Whether it's a git repository |
| `current.currentCommit` | string? | Current HEAD commit hash |
| `current.currentBranch` | string? | Current branch (null if detached) |
| `current.originUrl` | string? | Current origin remote URL |
| `current.owner` | string? | Current directory owner |
| `current.group` | string? | Current directory group |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

If the path exists but is not a git repository, the model fails rather than destroying existing data. Detached HEAD is expected when checking out a tag or commit hash. Shallow clones are automatically unshallowed when checking out a specific commit.

### Example

```yaml
type: "@cfgmgmt/git"
name: app-repo
globalArguments:
  path: /var/www/myapp
  repo: "https://github.com/example/myapp.git"
  revision: main
  ensure: present
  owner: www-data
  group: www-data
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/archive

Extract archives idempotently on a remote node.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `source` | string | — | yes | Path to the archive file on the remote node |
| `dest` | string | — | yes | Extraction destination directory |
| `format` | enum | `"auto"` | no | `"auto"`, `"tar"`, `"tar.gz"`, `"tar.bz2"`, `"tar.xz"`, or `"zip"` |
| `creates` | string | — | no | Idempotency guard: skip if this path exists |
| `owner` | string | — | no | Owner for extracted files |
| `group` | string | — | no | Group for extracted files |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

**Idempotency:** If `creates` is set, extraction is skipped when that path exists. If `creates` is not set, extraction is skipped when the `dest` directory exists.

### Methods

| Method | Description |
|---|---|
| `check` | Check if archive has been extracted (dry-run) |
| `apply` | Extract an archive to the destination directory |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `source` | string | Archive source path |
| `dest` | string | Extraction destination |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.sourceExists` | boolean | Whether the source archive exists |
| `current.destExists` | boolean | Whether the destination directory exists |
| `current.createsExists` | boolean | Whether the creates guard path exists |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

Format is auto-detected from the file extension when set to `"auto"`. For `.zip` archives, `unzip` must be installed on the remote node.

### Example

```yaml
type: "@cfgmgmt/archive"
name: app-release
globalArguments:
  source: /tmp/myapp-v2.1.0.tar.gz
  dest: /opt/myapp
  creates: /opt/myapp/bin/myapp
  owner: appuser
  group: appuser
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/line

Edit individual lines in files using regex matching. Similar to Ansible's `lineinfile` or Puppet's `file_line`.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `path` | string | — | yes | Absolute path of the file on the remote node |
| `regexp` | string | — | yes | Regular expression to match the target line |
| `line` | string | — | no | The line to insert or replace. Required when `ensure` is `present`. |
| `ensure` | enum | `"present"` | no | `"present"` to add/replace, `"absent"` to remove matching line |
| `insertAfter` | string | — | no | Regex — insert after last match if `regexp` has no match |
| `insertBefore` | string | — | no | Regex — insert before first match if `regexp` has no match |
| `createFile` | boolean | `true` | no | Create the file if it does not exist (`ensure=present` only) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if the line matches desired state in the file (dry-run) |
| `apply` | Ensure a line is present or absent in the file |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `path` | string | File path |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.fileExists` | boolean | Whether the file exists |
| `current.matchFound` | boolean | Whether the regexp matched a line |
| `current.matchedLine` | string? | The line that matched |
| `current.lineNumber` | number? | Line number of the match (1-based) |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example — set a config value

```yaml
type: "@cfgmgmt/line"
name: nginx-worker-procs
globalArguments:
  path: /etc/nginx/nginx.conf
  regexp: "^worker_processes"
  line: "worker_processes auto;"
  ensure: present
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — remove a line

```yaml
type: "@cfgmgmt/line"
name: remove-debug-line
globalArguments:
  path: /etc/myapp/config.ini
  regexp: "^debug\\s*="
  ensure: absent
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/fetch

Download files from URLs to remote hosts with checksum verification. Similar to Ansible's `get_url` or Chef's `remote_file`.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `url` | string | — | yes | URL to download |
| `path` | string | — | yes | Absolute destination path on the remote node |
| `checksum` | string | — | no | Expected checksum for idempotency |
| `checksumType` | enum | `"sha256"` | no | `"sha256"`, `"sha1"`, or `"md5"` |
| `owner` | string | — | no | File owner |
| `group` | string | — | no | File group |
| `mode` | string | — | no | File permissions in octal (e.g. `0755`) |
| `force` | boolean | `false` | no | Re-download even if file exists and checksum matches |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

**Idempotency:** If `checksum` is set, the file is only downloaded when the existing file's checksum doesn't match. After download, the checksum is verified and the file is removed on mismatch.

### Methods

| Method | Description |
|---|---|
| `check` | Check if the file exists and matches the expected checksum (dry-run) |
| `apply` | Download the file and set ownership/permissions |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `url` | string | Source URL |
| `path` | string | Destination path |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.fileExists` | boolean | Whether the file exists |
| `current.checksum` | string? | Current file checksum |
| `current.owner` | string? | Current file owner |
| `current.group` | string? | Current file group |
| `current.mode` | string? | Current file mode |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/fetch"
name: download-binary
globalArguments:
  url: "https://github.com/example/app/releases/download/v1.0/app-linux-amd64"
  path: /usr/local/bin/app
  checksum: "a1b2c3d4e5f6..."
  checksumType: sha256
  owner: root
  mode: "0755"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/apt_repository

Manage apt package sources and GPG keys on Debian/Ubuntu. Supports both DEB822 format (`.sources`) and legacy one-line format (`.list`).

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `name` | string | — | yes | Repository identifier for the filename |
| `ensure` | enum | `"present"` | no | `"present"` to add, `"absent"` to remove |
| `uris` | string[] | — | no | Repository URIs (DEB822 format) |
| `suites` | string[] | — | no | Repository suites (DEB822 format) |
| `components` | string[] | — | no | Repository components (DEB822 format) |
| `architectures` | string[] | — | no | Architectures to enable (DEB822 format) |
| `signedBy` | string | — | no | Path to GPG keyring file on the remote node |
| `gpgKeyUrl` | string | — | no | URL to download the GPG key (dearmored automatically) |
| `sourceLine` | string | — | no | Legacy one-line format (mutually exclusive with `uris`/`suites`/`components`) |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if the apt repository is configured as desired (dry-run) |
| `apply` | Configure or remove an apt repository |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `name` | string | Repository name |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.repoFileExists` | boolean | Whether the repo source file exists |
| `current.gpgKeyExists` | boolean | Whether the GPG key file exists |
| `current.repoContent` | string? | Current repo file content |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example — DEB822 format (recommended)

```yaml
type: "@cfgmgmt/apt_repository"
name: docker
globalArguments:
  name: docker
  ensure: present
  uris: ["https://download.docker.com/linux/ubuntu"]
  suites: ["noble"]
  components: ["stable"]
  architectures: ["amd64"]
  signedBy: /usr/share/keyrings/docker.gpg
  gpgKeyUrl: "https://download.docker.com/linux/ubuntu/gpg"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

### Example — legacy one-line format

```yaml
type: "@cfgmgmt/apt_repository"
name: nodesource
globalArguments:
  name: nodesource
  ensure: present
  sourceLine: "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main"
  signedBy: /usr/share/keyrings/nodesource.gpg
  gpgKeyUrl: "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/dnf_repository

Manage dnf/yum repository files on Fedora/RHEL systems.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `name` | string | — | yes | Repository ID (used as `[section]` name and `.repo` filename) |
| `ensure` | enum | `"present"` | no | `"present"` to add, `"absent"` to remove |
| `description` | string | — | no | Human-readable repository name |
| `baseurl` | string | — | no | Base URL of the repository |
| `metalink` | string | — | no | Metalink URL (alternative to `baseurl`) |
| `mirrorlist` | string | — | no | Mirror list URL (alternative to `baseurl`) |
| `enabled` | boolean | `true` | no | Whether the repository is enabled |
| `gpgcheck` | boolean | `true` | no | Whether GPG signature checking is enabled |
| `gpgkey` | string | — | no | URL of the GPG key for the repository |
| `sslverify` | boolean | — | no | Whether to verify SSL certificates |
| `repo_gpgcheck` | boolean | — | no | Whether to verify repository metadata GPG signatures |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if the dnf repository is configured as desired (dry-run) |
| `apply` | Configure or remove a dnf/yum repository |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `name` | string | Repository name |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.repoFileExists` | boolean | Whether the `.repo` file exists |
| `current.repoContent` | string? | Current `.repo` file content |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/dnf_repository"
name: docker-ce-stable
globalArguments:
  name: docker-ce-stable
  ensure: present
  description: "Docker CE Stable"
  baseurl: "https://download.docker.com/linux/fedora/$releasever/$basearch/stable"
  gpgcheck: true
  gpgkey: "https://download.docker.com/linux/fedora/gpg"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/kernel_module

Load or unload kernel modules and persist them across reboots via `/etc/modules-load.d/`.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `name` | string | — | yes | Kernel module name (e.g. `br_netfilter`, `overlay`) |
| `ensure` | enum | `"present"` | no | `"present"` to load, `"absent"` to unload |
| `params` | string | — | no | Module parameters (e.g. `"option1=value1"`) |
| `persist` | boolean | `true` | no | Persist across reboots via `/etc/modules-load.d/` |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if the module is loaded/persisted as desired (dry-run) |
| `apply` | Load or unload a kernel module and manage persistence |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `name` | string | Module name |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.loaded` | boolean | Whether the module is currently loaded |
| `current.persisted` | boolean | Whether a persistence file exists |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/kernel_module"
name: load-br-netfilter
globalArguments:
  name: br_netfilter
  ensure: present
  persist: true
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/reboot

Reboot a remote host and wait for SSH to become available again. The `check` method always reports `non_compliant` since reboot is an imperative action.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `timeout` | number | `300` | no | Maximum seconds to wait for the host to come back |
| `message` | string | `"Rebooting via cfgmgmt"` | no | Broadcast message before reboot |
| `testCommand` | string | `"uptime"` | no | Command to run after reconnection to verify health |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Always reports `non_compliant` — reboot is imperative |
| `apply` | Reboot the host and wait for SSH reconnection |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `preRebootUptime` | string? | System uptime before reboot |
| `postRebootUptime` | string? | System uptime after reboot |
| `changes` | string[] | List of changes applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/reboot"
name: reboot-after-kernel
globalArguments:
  timeout: 300
  message: "Kernel update applied"
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## @cfgmgmt/certificate

Deploy SSL/TLS certificates (cert, key, and optional chain) as a unit. Validates that the certificate and private key match using `openssl`.

### Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `name` | string | — | yes | Certificate name (label) |
| `certContent` | string | — | yes | PEM-encoded certificate content |
| `keyContent` | string (sensitive) | — | yes | PEM-encoded private key content |
| `chainContent` | string | — | no | PEM-encoded certificate chain |
| `certPath` | string | — | yes | Destination path for the certificate |
| `keyPath` | string | — | yes | Destination path for the private key |
| `chainPath` | string | — | no | Destination path for the chain |
| `owner` | string | — | no | Owner for all certificate files |
| `group` | string | — | no | Group for all certificate files |
| `certMode` | string | `"0644"` | no | Permissions for the certificate file |
| `keyMode` | string | `"0600"` | no | Permissions for the private key (restricted by default) |
| `chainMode` | string | `"0644"` | no | Permissions for the chain file |
| `validate` | boolean | `true` | no | Validate cert/key match via `openssl` |
| *(SSH fields)* | | | | See [SSH connection](#ssh-connection) |
| *(become fields)* | | | | See [Privilege escalation](#privilege-escalation-become) |

### Methods

| Method | Description |
|---|---|
| `check` | Check if certificates are deployed and match desired state (dry-run) |
| `apply` | Deploy certificate, key, and optional chain to the remote node |

### Output — `state`

| Field | Type | Description |
|---|---|---|
| `name` | string | Certificate name |
| `status` | enum | `compliant`, `non_compliant`, `applied`, or `failed` |
| `current.certExists` | boolean | Whether the cert file exists |
| `current.keyExists` | boolean | Whether the key file exists |
| `current.chainExists` | boolean | Whether the chain file exists |
| `current.certSha256` | string? | SHA-256 of current cert file |
| `current.keySha256` | string? | SHA-256 of current key file |
| `current.chainSha256` | string? | SHA-256 of current chain file |
| `current.certKeyMatch` | boolean? | Whether cert and key modulus match |
| `changes` | string[] | List of changes detected or applied |
| `error` | string? | Error message if status is `failed` |
| `timestamp` | string | ISO 8601 timestamp |

### Example

```yaml
type: "@cfgmgmt/certificate"
name: web-cert
globalArguments:
  name: web-cert
  certContent: ${{ vault.get("web-cert", "cert") }}
  keyContent: ${{ vault.get("web-cert", "key") }}
  chainContent: ${{ vault.get("web-cert", "chain") }}
  certPath: /etc/ssl/certs/web.crt
  keyPath: /etc/ssl/private/web.key
  chainPath: /etc/ssl/certs/web-chain.crt
  owner: root
  group: ssl-cert
  nodeHost: "192.168.1.50"
  nodeUser: deploy
  become: true
```

---

## End-to-end example: deploy nginx on Fedora

This workflow ties together multiple cfgmgmt models to deploy nginx across a fleet of Fedora servers. It uses a non-root `deploy` user with `become: true` for privilege escalation, and demonstrates the multi-host factory pattern where a single model targets multiple hosts via `forEach`.

### Models

Models declare connection fields (`nodeHost`/`nodeIdentityFile`) as runtime `inputs`, referenced via `${{ inputs.* }}` in `globalArguments`. The workflow provides per-host values at each `forEach` iteration.

```yaml
# models/webserver.yaml
type: "@cfgmgmt/node"
name: webserver
inputs:
  properties:
    hostname:
      type: string
    sshIdentityFile:
      type: string
  required: [hostname, sshIdentityFile]
globalArguments:
  hostname: ${{ inputs.hostname }}
  sshUser: deploy
  sshIdentityFile: ${{ inputs.sshIdentityFile }}
```

```yaml
# models/nginx-pkg.yaml
type: "@cfgmgmt/dnf"
name: nginx-pkg
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  packages:
    - nginx
  ensure: present
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

```yaml
# models/nginx-docroot.yaml
type: "@cfgmgmt/directory"
name: nginx-docroot
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  path: /var/www/html
  ensure: present
  owner: nginx
  group: nginx
  mode: "0755"
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

```yaml
# models/nginx-conf.yaml
type: "@cfgmgmt/file"
name: nginx-conf
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  path: /etc/nginx/nginx.conf
  ensure: present
  content: |
    worker_processes auto;
    events { worker_connections 1024; }
    http {
      include /etc/nginx/conf.d/*.conf;
    }
  owner: root
  group: root
  mode: "0644"
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

```yaml
# models/nginx-svc.yaml
type: "@cfgmgmt/systemd"
name: nginx-svc
inputs:
  properties:
    nodeHost:
      type: string
    nodeIdentityFile:
      type: string
  required: [nodeHost, nodeIdentityFile]
globalArguments:
  service: nginx
  ensure: running
  enabled: true
  nodeHost: ${{ inputs.nodeHost }}
  nodeUser: deploy
  nodeIdentityFile: ${{ inputs.nodeIdentityFile }}
  become: true
```

### Workflow — single host

When targeting a single host, pass the connection values directly in `task.inputs`:

```yaml
name: deploy-nginx
description: Deploy nginx to a Fedora web server
jobs:
  - name: deploy
    steps:
      - name: gather
        description: Gather node facts
        task:
          type: model_method
          modelIdOrName: webserver
          methodName: gather
          inputs:
            hostname: "192.168.1.50"
            sshIdentityFile: /home/deploy/.ssh/id_ed25519

      - name: install
        description: Install nginx package
        task:
          type: model_method
          modelIdOrName: nginx-pkg
          methodName: apply
          inputs:
            nodeHost: "192.168.1.50"
            nodeIdentityFile: /home/deploy/.ssh/id_ed25519

      - name: docroot
        description: Create document root
        task:
          type: model_method
          modelIdOrName: nginx-docroot
          methodName: apply
          inputs:
            nodeHost: "192.168.1.50"
            nodeIdentityFile: /home/deploy/.ssh/id_ed25519

      - name: config
        description: Deploy nginx config
        task:
          type: model_method
          modelIdOrName: nginx-conf
          methodName: apply
          inputs:
            nodeHost: "192.168.1.50"
            nodeIdentityFile: /home/deploy/.ssh/id_ed25519

      - name: start
        description: Enable and start nginx
        task:
          type: model_method
          modelIdOrName: nginx-svc
          methodName: apply
          inputs:
            nodeHost: "192.168.1.50"
            nodeIdentityFile: /home/deploy/.ssh/id_ed25519
version: 1
```

### Workflow — multi-host factory pattern

The same models target multiple hosts using `forEach`. Each iteration overrides connection fields via `task.inputs`. Each host's data is stored under its own instance name (the host IP), so results never collide.

```yaml
name: deploy-nginx-fleet
description: Deploy nginx to a fleet of Fedora web servers
inputs:
  properties:
    hosts:
      type: array
      items:
        type: string
      default: ["192.168.1.50", "192.168.1.51", "192.168.1.52"]
    sshKey:
      type: string
      default: /home/deploy/.ssh/id_ed25519
jobs:
  - name: gather-facts
    description: Gather node facts
    steps:
      - name: gather-${{ self.host }}
        description: Gather facts from host
        forEach:
          item: host
          in: ${{ inputs.hosts }}
        task:
          type: model_method
          modelIdOrName: webserver
          methodName: gather
          inputs:
            hostname: ${{ self.host }}
            sshIdentityFile: ${{ inputs.sshKey }}
  - name: install
    description: Install nginx
    dependsOn:
      - job: gather-facts
        condition:
          type: succeeded
    steps:
      - name: install-${{ self.host }}
        description: Install nginx package
        forEach:
          item: host
          in: ${{ inputs.hosts }}
        task:
          type: model_method
          modelIdOrName: nginx-pkg
          methodName: apply
          inputs:
            nodeHost: ${{ self.host }}
            nodeIdentityFile: ${{ inputs.sshKey }}
  - name: configure
    description: Configure nginx
    dependsOn:
      - job: install
        condition:
          type: succeeded
    steps:
      - name: docroot-${{ self.host }}
        description: Create document root
        forEach:
          item: host
          in: ${{ inputs.hosts }}
        task:
          type: model_method
          modelIdOrName: nginx-docroot
          methodName: apply
          inputs:
            nodeHost: ${{ self.host }}
            nodeIdentityFile: ${{ inputs.sshKey }}
      - name: config-${{ self.host }}
        description: Deploy nginx config
        forEach:
          item: host
          in: ${{ inputs.hosts }}
        task:
          type: model_method
          modelIdOrName: nginx-conf
          methodName: apply
          inputs:
            nodeHost: ${{ self.host }}
            nodeIdentityFile: ${{ inputs.sshKey }}
  - name: start-service
    description: Start nginx
    dependsOn:
      - job: configure
        condition:
          type: succeeded
    steps:
      - name: start-${{ self.host }}
        description: Enable and start nginx
        forEach:
          item: host
          in: ${{ inputs.hosts }}
        task:
          type: model_method
          modelIdOrName: nginx-svc
          methodName: apply
          inputs:
            nodeHost: ${{ self.host }}
            nodeIdentityFile: ${{ inputs.sshKey }}
version: 1
```

After running, each model stores per-host data:

```bash
swamp data list nginx-pkg
# nginx-pkg / state / 192.168.1.50
# nginx-pkg / state / 192.168.1.51
# nginx-pkg / state / 192.168.1.52
```

Query a specific host's state with CEL:

```
data.latest("nginx-pkg", "192.168.1.50").attributes.status
```

Or get all hosts' states:

```
data.findBySpec("nginx-pkg", "state")
```

# Remote access from a phone (DuckDNS + Caddy HTTPS)

This guide makes the downloader's web UI reachable from a phone over the internet, using a free DuckDNS name and HTTPS.

**Security first.** The downloader's web UI can pause, delete, and purge jobs. Never expose it over plain HTTP, and never expose it without a token. The setup below only exposes Caddy (HTTPS, ports 80 and 443). The downloader itself stays on `127.0.0.1:3000`.

Replace these placeholders with your own values:

- `uniquegamer` — your DuckDNS subdomain (the address is `uniquegamer.duckdns.org`; enter only `uniquegamer` in scripts)
- `192.168.0.102` — this PC's LAN IP
- `YOUR_DUCKDNS_TOKEN` — the token from duckdns.org
- `YOUR_WEB_TOKEN` — a new random token for the web UI (20+ characters)

---

## 1. Check that port forwarding can work

1. Find your public IP: search "what is my IP" on the PC.
2. Open the router admin page (Tenda) and find the WAN IP.
3. If the two addresses match, port forwarding can work.
4. If they differ, your ISP uses carrier-grade NAT. Port forwarding will not work. Use Tailscale instead (no port forwards needed).

## 2. Router port forwards

Keep only these rules. All are TCP, pointing at the PC:

| External port | Internal IP | Internal port | Purpose |
|---|---|---|---|
| 80 | 192.168.0.102 | 80 | Caddy: certificate issuance and redirect |
| 443 | 192.168.0.102 | 443 | Caddy: HTTPS for the web UI |

Remove the rules for external ports **25**, **22**, and **23**. The downloader's port 3000 must not be forwarded.

## 3. Windows Firewall

Allow inbound TCP **80** and **443** on the Private network profile:

```powershell
New-NetFirewallRule -DisplayName "Caddy HTTP" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Caddy HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private
```

Run PowerShell as administrator.

## 4. Install Caddy

1. Download the Windows build from https://caddyserver.com/download.
2. Put `caddy.exe` in `F:\v9\caddy`.
3. Create `F:\v9\caddy\Caddyfile` with exactly this content:

   ```
   uniquegamer.duckdns.org {
       reverse_proxy 127.0.0.1:3000
   }
   ```

Caddy requests and renews the TLS certificate automatically. It needs ports 80 and 443 reachable from the internet.

## 5. DuckDNS updater script

DuckDNS needs to know your current public IP. Create `C:\Tools\update-duckdns.ps1`:

```powershell
# update-duckdns.ps1 — keeps uniquegamer.duckdns.org pointed at this PC's public IP.
# DuckDNS uses the requesting IP when "ip" is empty.

# Windows PowerShell 5.1 can default to older TLS; DuckDNS requires TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$domain  = "uniquegamer"
$token   = "YOUR_DUCKDNS_TOKEN"
$logFile = "$PSScriptRoot\duckdns-update.log"

if ($token -eq "YOUR_DUCKDNS_TOKEN") {
    Write-Host "Set your DuckDNS token in this script first." -ForegroundColor Red
    exit 1
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$uri = "https://www.duckdns.org/update?domains=$domain&token=$token&ip="

try {
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -ErrorAction Stop
    $body = $response.Content.Trim()
    if ($body -eq "OK") {
        $msg = "[$timestamp] OK: ${domain}.duckdns.org updated (https://${domain}.duckdns.org)"
    } else {
        $msg = "[$timestamp] WARNING: DuckDNS replied '$body'"
    }
} catch {
    # The exception text can contain the full URL, including the token, so log only the type.
    $msg = "[$timestamp] ERROR: could not reach DuckDNS ($($_.Exception.GetType().Name))"
    Write-Host $msg -ForegroundColor Red
    Add-Content -Path $logFile -Value $msg
    exit 1
}

Write-Host $msg -ForegroundColor Green
Add-Content -Path $logFile -Value $msg
```

Test it by hand first:

```
powershell -ExecutionPolicy Bypass -File "C:\Tools\update-duckdns.ps1"
```

The output should be `OK: uniquegamer.duckdns.org updated`. If it shows `ERROR` instead, use the diagnostic below.

**Diagnostic (replace the token locally and don't share the output if it contains it):**

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
    $r = Invoke-WebRequest "https://www.duckdns.org/update?domains=uniquegamer&token=YOUR_DUCKDNS_TOKEN&ip=" -UseBasicParsing
    "STATUS: $($r.StatusCode)  BODY: $($r.Content)"
} catch {
    "ERROR TYPE: $($_.Exception.GetType().FullName)"
    "MESSAGE: $($_.Exception.Message)"
    if ($_.Exception.InnerException) { "INNER: $($_.Exception.InnerException.Message)" }
}
```

- `BODY: OK` → the script works; check the TLS line is present.
- `Could not create SSL/TLS secure channel` → the TLS line fixes it.
- Timeout or "connection forcibly closed" → antivirus, firewall, or VPN is interfering.
- `BODY: KO` → wrong token or domain. The domain is `uniquegamer`, without `http://` or `.duckdns.org`.

**Schedule it:** Task Scheduler → Create Task:

- Trigger: daily, repeat every 5 minutes, indefinitely.
- Action: program `powershell`, arguments `-ExecutionPolicy Bypass -File "C:\Tools\update-duckdns.ps1"`.
- Settings: run whether the user is logged on or not.

## 6. Start the downloader

Start the web UI on localhost only. Don't use `--lan` for this setup, since Caddy connects to it locally.

```
bun run start --port 3000 --webtoken YOUR_WEB_TOKEN
```

Do not put the web token in shared documents or chat. Use a new token, not one that has been posted anywhere.

## 7. Start Caddy

Open a separate PowerShell window and run:

```
F:\v9\caddy\caddy.exe run --config F:\v9\caddy\Caddyfile
```

Leave this window open. The first start takes a minute while the certificate is issued. Watch the output for certificate errors.

## 8. Connect from a phone

1. Turn off Wi-Fi on the phone, so it uses mobile data.
2. Open `https://uniquegamer.duckdns.org`.
3. Sign in with `YOUR_WEB_TOKEN`.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| DuckDNS script shows `ERROR` | Run the diagnostic above. Check the TLS line and the domain (`uniquegamer`). |
| Address doesn't resolve | DuckDNS not updated. Run the script by hand and check the log file. |
| Page times out | Ports 80/443 not forwarded, or Windows Firewall is blocking them. Check the router WAN IP against your public IP (step 1). |
| Browser shows a certificate error | Caddy couldn't get a certificate. Check the Caddy window. Port 80 must be reachable from the internet during issuance. |
| Login page loads but the token is rejected | Check you're using the web token, not the DuckDNS token. |
| Actions fail with "forbidden" or origin errors | The web UI checks the request origin. If this happens through Caddy, tell me and we'll adjust the proxy headers. |
| Address stops working after a while | Your public IP changed and the scheduled task isn't running. Check Task Scheduler and the log. |

## Limitations

- **Port forwarding works only if you have a real public IP** (step 1). Carrier-grade NAT blocks it.
- **Your phone connection is only as safe as the token.** Use a long random token and don't reuse it.
- **If your router has its own DDNS feature**, it can replace the DuckDNS script.
- **Tailscale is an alternative** that needs no port forwards at all.

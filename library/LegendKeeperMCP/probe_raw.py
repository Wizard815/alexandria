import asyncio
import json
import os


async def main():
    # Explicit env so we know exactly what the child process sees at boot.
    env = dict(os.environ)
    env["LEGENDKEEPER_API_KEY"] = "lk_dummy_test_key"

    proc = await asyncio.create_subprocess_exec(
        "legendkeeper-mcp",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE
    )

    async def reader_loop():
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            raw = line.decode(errors="replace").strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                print("[STDOUT] ", raw[:200])
                continue
            if isinstance(msg, dict):
                print(f"[MSG id={msg.get('id')} method={msg.get('method')}]")

    task = asyncio.create_task(reader_loop())

    # Send initialize handshake (protocolVersion + capabilities).
    seq = 1
    init = {
        "jsonrpc": "2.0",
        "id": seq,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "probe", "version": "0.1"},
        },
    }
    proc.stdin.write((json.dumps(init) + "\n").encode())
    await proc.stdin.drain()

    # Allow the server to answer initialize.
    await asyncio.sleep(3)

    # Notify that we're initialized.
    notif = {"jsonrpc": "2.0", "method": "notifications/initialized"}
    proc.stdin.write((json.dumps(notif) + "\n").encode())
    await proc.stdin.drain()

    # Now request tools/list.
    seq += 1
    list_req = {"jsonrpc": "2.0", "id": seq, "method": "tools/list", "params": {}}
    proc.stdin.write((json.dumps(list_req) + "\n").encode())
    await proc.stdin.drain()

    # Wait a bit for the response.
    await asyncio.sleep(3)

    # Clean shutdown.
    try:
        await proc.send_signal("\x03")
    except Exception:
        pass
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass


asyncio.run(main())

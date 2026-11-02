import asyncio
import logging
import os

logging.disable(logging.CRITICAL)


async def main():
    env = dict(os.environ)
    env["LEGENDKEEPER_API_KEY"] = "lk_dummy_test_key"

    from mcp.client.stdio import StdioServerParameters, stdio_client
    from mcp.client.session import ClientSession

    params = StdioServerParameters(command="legendkeeper-mcp", args=[], env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            resp = await session.list_tools()
            tools = sorted(resp.tools, key=lambda t: t.name)
            print(f"INIT OK | TOOL_COUNT: {len(tools)}\n---")
            for tl in tools[:10]:
                schema = tl.input_schema if isinstance(tl.input_schema, dict) else {}
                required = list(schema.get("required", []))
                props = list(schema.get("properties", {}).keys())
                print(f"- {tl.name}  | required={required}")
                if props:
                    print(f"    optional: {props}")
            print("...")
            for tl in tools[10:]:
                print("-", tl.name)


asyncio.run(main())

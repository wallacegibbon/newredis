const { createConnection, execute } = require("../lib/basic");


function delay(milliseconds) {
  return new Promise((res, _) => setTimeout(res, milliseconds));
}


async function send4ever(conn) {
  await execute(conn, [ "hmset", "test_hash", "name", "wallace", "age", 26 ]);
  while (true) {
    console.log("==Sending command request...");

    var r = await execute(conn, [ "get", "test_string" ]);
    console.log("==Request result:", r);

    console.log("==Sending ERROR command request...");

    //var r = await execute(conn, [ "ssget", "test_string" ]);
    var r = await execute(conn, [ "get", "test_hash" ]);
    console.log("==Request result:", r);

    await delay(1000);
  }
}

async function test() {
  try {
    console.log("Trying to create connection to redis server...");
    const conn = await createConnection(6379, "localhost");
    console.log("Trying to send request to redis server...");
    await send4ever(conn);
  } catch (e) {
    console.error("**Err:", e.message);
  }
}


test().catch(console.error);


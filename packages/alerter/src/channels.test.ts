import { expect, test } from "bun:test";
import { createLiveChannels } from "./channels.ts";

type FetchArgs = { url: string; init: RequestInit };

function fetchRecorder(status = 200) {
  const calls: FetchArgs[] = [];
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response("ok", { status }));
  };
  return { calls, fetchImpl };
}

test("sendEmail POSTs to Resend with auth + from + recipients", async () => {
  const { calls, fetchImpl } = fetchRecorder();
  const channels = createLiveChannels({
    resendApiKey: "re_test",
    fromEmail: "alerts@example.com",
    fetchImpl,
  });
  await channels.sendEmail(["ops@acme.test"], { subject: "S", text: "B" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.resend.com/emails");
  const headers = new Headers(calls[0]!.init.headers);
  expect(headers.get("authorization")).toBe("Bearer re_test");
  const body = JSON.parse(String(calls[0]!.init.body));
  expect(body.from).toBe("alerts@example.com");
  expect(body.to).toEqual(["ops@acme.test"]);
  expect(body.subject).toBe("S");
});

test("sendEmail throws on a non-2xx Resend response", async () => {
  const { fetchImpl } = fetchRecorder(422);
  const channels = createLiveChannels({ resendApiKey: "re_test", fromEmail: "a@b.c", fetchImpl });
  await expect(channels.sendEmail(["x@y.z"], { subject: "S", text: "B" })).rejects.toThrow();
});

test("postSlack POSTs the text payload to the webhook URL", async () => {
  const { calls, fetchImpl } = fetchRecorder();
  const channels = createLiveChannels({ resendApiKey: "re_test", fromEmail: "a@b.c", fetchImpl });
  await channels.postSlack("https://hooks.slack.com/services/x", "hello");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://hooks.slack.com/services/x");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "hello" });
});

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");

let testEnv;
const PROJECT_ID = process.env.GCP_PROJECT || "demo-no-project";
const ALICE_UID = "alice_uid_123";
const BOB_UID = "bob_uid_456";

const [emulatorHost, emulatorPortStr] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085").split(":");
const emulatorPort = parseInt(emulatorPortStr, 10);

before(async () => {
  const rules = fs.readFileSync("./firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: emulatorHost,
      port: emulatorPort,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

function pastDate(offsetMs = 5000) {
  return new Date(Date.now() - offsetMs);
}

test("Unauthenticated users cannot read or write any collection", async () => {
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).get());
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("knowledge_docs").get());
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("workflows").get());
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("email_drafts").get());
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("meetings").get());
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("browser_tasks").get());

  await assertFails(
    unauthDb.collection("users").doc(ALICE_UID).collection("knowledge_docs").doc("doc1").set({
      userId: ALICE_UID,
      title: "Policy",
      category: "POLICY",
      content: "Test",
      enabled: true,
      tags: ["hr"],
      createdAt: pastDate(),
      updatedAt: pastDate(),
    })
  );
});

test("UserProfile: owner create, partial update, cross-user isolation, and shadow field rejection", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
  const ts = pastDate(10000);

  await assertSucceeds(
    aliceDb.collection("users").doc(ALICE_UID).set({
      userId: ALICE_UID,
      displayName: "Alice",
      companyName: "Acme Corp",
      assistantPersona: "Concise executive assistant",
      whatsappNumber: "+15551234567",
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // Partial update allowed
  await assertSucceeds(
    aliceDb.collection("users").doc(ALICE_UID).update({
      companyName: "Acme Global",
      updatedAt: pastDate(1000),
    })
  );

  // Reject immutable createdAt modification
  await assertFails(
    aliceDb.collection("users").doc(ALICE_UID).update({
      createdAt: pastDate(500),
      updatedAt: pastDate(500),
    })
  );

  // Reject ghost field
  await assertFails(
    aliceDb.collection("users").doc(ALICE_UID).update({
      isAdmin: true,
      updatedAt: pastDate(500),
    })
  );

  // Bob cannot read or write Alice's profile
  await assertFails(bobDb.collection("users").doc(ALICE_UID).get());
  await assertFails(bobDb.collection("users").doc(ALICE_UID).update({ companyName: "Hijack", updatedAt: pastDate(500) }));
});

test("KnowledgeDoc: owner CRUD, list query, toggle enabled, and validation bounds", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
  const ts = pastDate(10000);
  const col = aliceDb.collection("users").doc(ALICE_UID).collection("knowledge_docs");

  // Empty list succeeds for owner
  await assertSucceeds(col.get());

  await assertSucceeds(
    col.doc("doc_1").set({
      userId: ALICE_UID,
      title: "Refund SLA Policy",
      category: "POLICY",
      content: "Refunds under $500 are auto-approved within 24 hours.",
      enabled: true,
      tags: ["refund", "sla"],
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertSucceeds(col.doc("doc_1").update({ enabled: false, updatedAt: pastDate(1000) }));

  // Reject invalid @DocumentId 'id' inside payload
  await assertFails(
    col.doc("doc_2").set({
      id: "doc_2",
      userId: ALICE_UID,
      title: "Bad Doc",
      category: "POLICY",
      content: "Should fail due to id field",
      enabled: true,
      tags: [],
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // Reject future timestamp
  await assertFails(
    col.doc("doc_3").set({
      userId: ALICE_UID,
      title: "Future Doc",
      category: "SOP",
      content: "Tampered timestamp",
      enabled: true,
      tags: [],
      createdAt: new Date(Date.now() + 60000),
      updatedAt: ts,
    })
  );

  // Cross-user denial
  await assertFails(bobDb.collection("users").doc(ALICE_UID).collection("knowledge_docs").get());
  await assertFails(bobDb.collection("users").doc(ALICE_UID).collection("knowledge_docs").doc("doc_1").delete());
});

test("WorkflowRun: multi-step execution and terminal COMPLETED state locking", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const ts = pastDate(10000);
  const wfRef = aliceDb.collection("users").doc(ALICE_UID).collection("workflows").doc("wf_1");

  await assertSucceeds(
    wfRef.set({
      userId: ALICE_UID,
      prompt: "Schedule sync with Sarah and send WhatsApp confirmation",
      channel: "WHATSAPP",
      status: "PLANNED",
      whatsappReply: "Hi Sarah, I've scheduled our sync for tomorrow at 2 PM.",
      summary: "Planned meeting and drafted WhatsApp reply.",
      steps: ["[ ] Check calendar", "[ ] Draft reply"],
      completedStepCount: 0,
      targetContact: "Sarah",
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertSucceeds(
    wfRef.update({
      status: "COMPLETED",
      steps: ["[x] Check calendar", "[x] Draft reply"],
      completedStepCount: 2,
      updatedAt: pastDate(1000),
    })
  );

  // Locked once COMPLETED
  await assertFails(
    wfRef.update({
      status: "IN_PROGRESS",
      updatedAt: pastDate(500),
    })
  );

  // Delete still permitted for owner
  await assertSucceeds(wfRef.delete());
});

test("EmailDraft, MeetingItem, and BrowserTask: owner payloads and terminal locks", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const ts = pastDate(10000);

  const emailRef = aliceDb.collection("users").doc(ALICE_UID).collection("email_drafts").doc("email_1");
  await assertSucceeds(
    emailRef.set({
      userId: ALICE_UID,
      recipient: "client@example.com",
      subject: "Re: Enterprise Onboarding",
      body: "Hello, attached is our SLA timeline per company policy.",
      incomingContext: "Client asked for onboarding SLA.",
      priority: "HIGH",
      status: "DRAFTED",
      createdAt: ts,
      updatedAt: ts,
    })
  );
  await assertSucceeds(emailRef.update({ status: "SENT", updatedAt: pastDate(1000) }));
  await assertFails(emailRef.update({ subject: "Edited after sent", updatedAt: pastDate(500) }));

  const meetingRef = aliceDb.collection("users").doc(ALICE_UID).collection("meetings").doc("mtg_1");
  await assertSucceeds(
    meetingRef.set({
      userId: ALICE_UID,
      title: "Q4 Automation Review",
      participants: "ops@acme.com, founder@acme.com",
      startTimeIso: "2026-11-20 15:00",
      durationMinutes: 45,
      agenda: "Review WhatsApp bot workflows and SLA compliance.",
      meetingLink: "https://meet.google.com/abc-defg-hij",
      status: "PROPOSED",
      createdAt: ts,
      updatedAt: ts,
    })
  );
  await assertSucceeds(meetingRef.update({ status: "CONFIRMED", updatedAt: pastDate(1000) }));
  await assertSucceeds(meetingRef.update({ status: "CANCELLED", updatedAt: pastDate(500) }));
  await assertFails(meetingRef.update({ status: "CONFIRMED", updatedAt: pastDate(100) }));

  const browserRef = aliceDb.collection("users").doc(ALICE_UID).collection("browser_tasks").doc("bt_1");
  await assertSucceeds(
    browserRef.set({
      userId: ALICE_UID,
      title: "Vendor Portal Intake",
      targetUrl: "https://httpbin.org/forms/post",
      instructions: "Fill customer name and email fields",
      fieldMappings: ["custname=Acme Corp", "custemail=ops@acme.com"],
      pythonScript: "from playwright.sync_api import sync_playwright\n# ...",
      status: "READY",
      createdAt: ts,
      updatedAt: ts,
    })
  );
  await assertSucceeds(browserRef.update({ status: "EXECUTED", updatedAt: pastDate(1000) }));
});

test("WebhookLog: owner lifecycle, triage updates, terminal REPLIED lock, and cross-user isolation", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
  const ts = pastDate(10000);

  const logRef = aliceDb.collection("users").doc(ALICE_UID).collection("webhook_logs").doc("wh_1");
  await assertSucceeds(
    logRef.set({
      userId: ALICE_UID,
      sourcePlatform: "META_CLOUD",
      direction: "INCOMING",
      eventType: "messages.upsert",
      sender: "+15551234567",
      messageBody: "Can you check my refund SLA status?",
      triageStatus: "RECEIVED",
      priority: "NORMAL",
      triageSummary: "",
      suggestedReply: "",
      httpStatusCode: 200,
      latencyMs: 84,
      rawPayload: "{\"entry\":[{\"id\":\"123\"}]}",
      errorMessage: "",
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // Triage AI update permitted
  await assertSucceeds(
    logRef.update({
      triageStatus: "TRIAGED",
      priority: "HIGH",
      triageSummary: "Urgent SLA inquiry matched against Refund Policy",
      suggestedReply: "Hi! Your request qualifies under our 24h SLA.",
      latencyMs: 412,
      updatedAt: pastDate(2000),
    })
  );

  // Sender is immutable on updates
  await assertFails(
    logRef.update({
      sender: "+19999999999",
      updatedAt: pastDate(1500),
    })
  );

  // Cross-user read & write denied
  await assertFails(bobDb.collection("users").doc(ALICE_UID).collection("webhook_logs").doc("wh_1").get());
  await assertFails(
    bobDb.collection("users").doc(ALICE_UID).collection("webhook_logs").doc("wh_2").set({
      userId: ALICE_UID,
      sourcePlatform: "META_CLOUD",
      direction: "INCOMING",
      eventType: "messages.upsert",
      sender: "+1555",
      messageBody: "spoof",
      triageStatus: "RECEIVED",
      priority: "LOW",
      triageSummary: "",
      suggestedReply: "",
      httpStatusCode: 200,
      latencyMs: 10,
      rawPayload: "",
      errorMessage: "",
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // Mark REPLIED (terminal lock)
  await assertSucceeds(logRef.update({ triageStatus: "REPLIED", updatedAt: pastDate(1000) }));
  await assertFails(logRef.update({ triageStatus: "TRIAGED", updatedAt: pastDate(500) }));

  // Owner can delete
  await assertSucceeds(logRef.delete());

  // Invalid status & negative latency rejected
  await assertFails(
    aliceDb.collection("users").doc(ALICE_UID).collection("webhook_logs").doc("wh_bad_status").set({
      userId: ALICE_UID,
      sourcePlatform: "META_CLOUD",
      direction: "INCOMING",
      eventType: "messages.upsert",
      sender: "+15551234567",
      messageBody: "Test",
      triageStatus: "BAD_STATUS",
      priority: "NORMAL",
      triageSummary: "",
      suggestedReply: "",
      httpStatusCode: 200,
      latencyMs: 50,
      rawPayload: "",
      errorMessage: "",
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertFails(
    aliceDb.collection("users").doc(ALICE_UID).collection("webhook_logs").doc("wh_bad_latency").set({
      userId: ALICE_UID,
      sourcePlatform: "META_CLOUD",
      direction: "INCOMING",
      eventType: "messages.upsert",
      sender: "+15551234567",
      messageBody: "Test",
      triageStatus: "RECEIVED",
      priority: "NORMAL",
      triageSummary: "",
      suggestedReply: "",
      httpStatusCode: 200,
      latencyMs: -1,
      rawPayload: "",
      errorMessage: "",
      createdAt: ts,
      updatedAt: ts,
    })
  );
});

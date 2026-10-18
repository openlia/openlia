import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { DocumentPasswordProfile } from "../../shared/api";
import type { WorkspaceApi } from "../api";
import { UploadModal } from "./UploadModal";

const mockProfiles: DocumentPasswordProfile[] = [
  {
    profile_id: "bank_chase",
    label: "Chase Bank Statements",
    hint: "Last 4 digits of SSN",
    description: "Monthly checking statements",
    patterns: ["*chase*", "*bank*"],
  },
  {
    profile_id: "payroll_corp",
    label: "Corporate Payroll",
    hint: "Employee ID",
    description: "Bi-weekly payslips",
    patterns: ["*payroll*", "*payslip*"],
  },
];

function createMockApi(
  profiles: DocumentPasswordProfile[] = mockProfiles,
  uploadHandler?: (formData: FormData) => Promise<unknown>,
) {
  return {
    listDocumentPasswords: vi.fn().mockResolvedValue({
      schema: 1,
      ok: true,
      profiles,
    }),
    uploadDocument: vi.fn().mockImplementation(
      uploadHandler ??
        (async (_formData: FormData) => ({
          schema: 1,
          ok: true,
          source_id: "src_123",
          version_id: "ver_001",
          job_id: "job_123",
        })),
    ),
    uploadDocumentJson: vi.fn().mockResolvedValue({
      schema: 1,
      ok: true,
      source_id: "src_123",
      version_id: "ver_001",
      job_id: "job_123",
    }),
  } as unknown as WorkspaceApi;
}

test("renders multiple files with per-file credentials and auto-suggestions", async () => {
  const file1 = new File(["chase statement"], "chase_statement_jan.pdf", {
    type: "application/pdf",
  });
  const file2 = new File(["unprotected image"], "photo.png", {
    type: "image/png",
  });

  const api = createMockApi();
  render(
    <UploadModal
      api={api}
      isOpen={true}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
      initialFiles={[file1, file2]}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("chase_statement_jan.pdf")).toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  // Verify file 1 was auto-assigned the Chase profile (pattern match >= 70%)
  const chaseSelect = screen.getByLabelText(
    "Password profile for chase_statement_jan.pdf",
  ) as HTMLSelectElement;
  expect(chaseSelect.value).toBe("bank_chase");

  // Verify file 2 does not have password protection checked
  const checkboxes = screen.getAllByRole("checkbox", {
    name: "🔒 Requires Password",
  }) as HTMLInputElement[];
  expect(checkboxes.length).toBe(2);
  expect(checkboxes[0]?.checked).toBe(true); // file 1 is checked
  expect(checkboxes[1]?.checked).toBe(false); // file 2 is not checked
});

test("allows setting different passwords on different files", async () => {
  const file1 = new File(["statement 1"], "file1.pdf", {
    type: "application/pdf",
  });
  const file2 = new File(["statement 2"], "file2.pdf", {
    type: "application/pdf",
  });

  const uploadedForms: FormData[] = [];
  const api = createMockApi(mockProfiles, async (formData) => {
    uploadedForms.push(formData);
    return { ok: true, source_id: "src_1" };
  });

  const onSuccess = vi.fn();
  const onClose = vi.fn();

  render(
    <UploadModal
      api={api}
      isOpen={true}
      onClose={onClose}
      onSuccess={onSuccess}
      initialFiles={[file1, file2]}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("file1.pdf")).toBeInTheDocument();
  });

  // Check Requires Password for both files
  const [checkbox1, checkbox2] = screen.getAllByRole("checkbox", {
    name: "🔒 Requires Password",
  });
  if (checkbox1) fireEvent.click(checkbox1);
  if (checkbox2) fireEvent.click(checkbox2);

  // For file 1, pick Chase profile
  const profileSelect1 = screen.getByLabelText(
    "Password profile for file1.pdf",
  );
  fireEvent.change(profileSelect1, { target: { value: "bank_chase" } });

  // For file 2, enter custom password
  const customPassInput2 = screen.getByLabelText(
    "Custom password for file2.pdf",
  );
  fireEvent.change(customPassInput2, { target: { value: "secret_file2" } });

  // Submit upload
  const uploadBtn = screen.getByRole("button", {
    name: /Upload & Ingest \(2\)/,
  });
  fireEvent.click(uploadBtn);

  await waitFor(() => {
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  expect(uploadedForms.length).toBe(2);

  // First form has password_profile = bank_chase
  expect(uploadedForms[0]?.get("password_profile")).toBe("bank_chase");
  expect(uploadedForms[0]?.get("password")).toBeNull();

  // Second form has password = secret_file2
  expect(uploadedForms[1]?.get("password")).toBe("secret_file2");
  expect(uploadedForms[1]?.get("password_profile")).toBeNull();
});

test("supports 'Apply to All' batch action", async () => {
  const file1 = new File(["doc 1"], "doc1.pdf", { type: "application/pdf" });
  const file2 = new File(["doc 2"], "doc2.pdf", { type: "application/pdf" });

  const api = createMockApi();
  render(
    <UploadModal
      api={api}
      isOpen={true}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
      initialFiles={[file1, file2]}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("doc1.pdf")).toBeInTheDocument();
  });

  // Open batch tools
  const toggleBatchBtn = screen.getByRole("button", {
    name: "Apply to all files ▼",
  });
  fireEvent.click(toggleBatchBtn);

  // Select payroll_corp for all
  const batchSelect = screen.getByLabelText("Batch password profile");
  fireEvent.change(batchSelect, { target: { value: "payroll_corp" } });

  const applyBtn = screen.getByRole("button", { name: "Apply to All Files" });
  fireEvent.click(applyBtn);

  // Both files should now have payroll_corp assigned
  const select1 = screen.getByLabelText(
    "Password profile for doc1.pdf",
  ) as HTMLSelectElement;
  const select2 = screen.getByLabelText(
    "Password profile for doc2.pdf",
  ) as HTMLSelectElement;

  expect(select1.value).toBe("payroll_corp");
  expect(select2.value).toBe("payroll_corp");
});

test("isolates errors when one file fails during upload", async () => {
  const file1 = new File(["good file"], "good.pdf", {
    type: "application/pdf",
  });
  const file2 = new File(["bad file"], "bad.pdf", { type: "application/pdf" });

  const api = createMockApi(mockProfiles, async (formData) => {
    const file = formData.get("files") as File;
    if (file.name === "bad.pdf") {
      throw new Error("Password decryption failed");
    }
    return { ok: true, source_id: "src_good" };
  });

  const onSuccess = vi.fn();
  const onClose = vi.fn();

  render(
    <UploadModal
      api={api}
      isOpen={true}
      onClose={onClose}
      onSuccess={onSuccess}
      initialFiles={[file1, file2]}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("good.pdf")).toBeInTheDocument();
  });

  const uploadBtn = screen.getByRole("button", {
    name: /Upload & Ingest \(2\)/,
  });
  fireEvent.click(uploadBtn);

  await waitFor(() => {
    expect(
      screen.getByText("Error: Password decryption failed"),
    ).toBeInTheDocument();
  });

  // Modal remains open and shows retry button for the 1 failed file
  expect(onClose).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: /Retry Failed \(1\)/ }),
  ).toBeInTheDocument();

  // good.pdf shows complete badge
  expect(screen.getByText("✓ Complete")).toBeInTheDocument();
});

test("limits replacement mode to one file", async () => {
  const file1 = new File(["version one"], "version-one.txt", {
    type: "text/plain",
  });
  const file2 = new File(["version two"], "version-two.txt", {
    type: "text/plain",
  });
  const api = createMockApi();

  render(
    <UploadModal
      api={api}
      isOpen={true}
      targetSourceId="src_existing"
      onClose={vi.fn()}
      onSuccess={vi.fn()}
      initialFiles={[file1, file2]}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("version-one.txt")).toBeInTheDocument();
  });
  expect(screen.queryByText("version-two.txt")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Upload New Version" }));
  await waitFor(() => expect(api.uploadDocument).toHaveBeenCalledTimes(1));
});

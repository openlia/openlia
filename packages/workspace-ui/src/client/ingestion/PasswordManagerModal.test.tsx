import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { DocumentPasswordProfile } from "../../shared/api";
import type { WorkspaceApi } from "../api";
import { PasswordManagerModal } from "./PasswordManagerModal";

const mockProfiles: DocumentPasswordProfile[] = [
  {
    profile_id: "bank_chase",
    label: "Chase Bank Statements",
    hint: "Last 4 digits of SSN",
    description: "Monthly checking statements",
    patterns: ["*chase*", "*statement*"],
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
  initialProfiles: DocumentPasswordProfile[] = mockProfiles,
) {
  let profiles = [...initialProfiles];
  return {
    listDocumentPasswords: vi.fn().mockImplementation(async () => ({
      schema: 1,
      ok: true,
      profiles,
    })),
    saveDocumentPassword: vi
      .fn()
      .mockImplementation(
        async (
          profileId: string,
          label: string,
          _password?: string,
          description?: string,
          hint?: string,
          patterns?: string[],
        ) => {
          const existingIdx = profiles.findIndex(
            (p) => p.profile_id === profileId,
          );
          const saved: DocumentPasswordProfile = {
            profile_id: profileId,
            label,
            description,
            hint,
            patterns,
          };
          if (existingIdx >= 0) {
            profiles[existingIdx] = saved;
          } else {
            profiles.push(saved);
          }
          return { schema: 1, ok: true, profile: saved };
        },
      ),
    deleteDocumentPassword: vi
      .fn()
      .mockImplementation(async (profileId: string) => {
        profiles = profiles.filter((p) => p.profile_id !== profileId);
        return { schema: 1, ok: true, deleted: profileId };
      }),
  } as unknown as WorkspaceApi;
}

test("renders password profiles list with metadata and patterns", async () => {
  const api = createMockApi();
  const onClose = vi.fn();

  render(<PasswordManagerModal api={api} isOpen={true} onClose={onClose} />);

  await waitFor(() => {
    expect(screen.getByText("Chase Bank Statements")).toBeInTheDocument();
    expect(screen.getByText("Corporate Payroll")).toBeInTheDocument();
  });

  expect(screen.getByText("bank_chase")).toBeInTheDocument();
  expect(screen.getByText(/Last 4 digits of SSN/)).toBeInTheDocument();
  expect(screen.getByText("Monthly checking statements")).toBeInTheDocument();
  expect(screen.getByText("*chase*")).toBeInTheDocument();
  expect(screen.getByText("*statement*")).toBeInTheDocument();
});

test("filters profiles via search input", async () => {
  const api = createMockApi();
  render(<PasswordManagerModal api={api} isOpen={true} onClose={vi.fn()} />);

  await waitFor(() => {
    expect(screen.getByText("Chase Bank Statements")).toBeInTheDocument();
  });

  const searchInput = screen.getByPlaceholderText(/Search profiles/i);
  fireEvent.change(searchInput, { target: { value: "payroll" } });

  expect(screen.queryByText("Chase Bank Statements")).toBeNull();
  expect(screen.getByText("Corporate Payroll")).toBeInTheDocument();
});

test("creates a new password profile", async () => {
  const api = createMockApi();
  const onChanged = vi.fn();

  render(
    <PasswordManagerModal
      api={api}
      isOpen={true}
      onClose={vi.fn()}
      onChanged={onChanged}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Chase Bank Statements")).toBeInTheDocument();
  });

  // Click Add Profile
  fireEvent.click(screen.getByRole("button", { name: /Add Profile/i }));

  expect(screen.getByText("Add New Password Profile")).toBeInTheDocument();

  // Fill in form
  const labelInput = screen.getByPlaceholderText(/Primary Bank Statements/i);
  fireEvent.change(labelInput, { target: { value: "Amex Statements" } });

  const idInput = screen.getByPlaceholderText(/bank_statements/i);
  // Auto-slugged or manual
  expect(idInput).toHaveValue("amex_statements");

  const passwordInput = screen.getByPlaceholderText("Enter document password");
  fireEvent.change(passwordInput, { target: { value: "secret123" } });

  const hintInput = screen.getByPlaceholderText(/Last 4 digits of tax ID/i);
  fireEvent.change(hintInput, { target: { value: "Card ending 1234" } });

  const descInput = screen.getByPlaceholderText(/Used for monthly checking/i);
  fireEvent.change(descInput, {
    target: { value: "Credit card PDF statements" },
  });

  const patternsInput = screen.getByPlaceholderText(
    /\*chase\*, \*bank\*, \*statement\*/i,
  );
  fireEvent.change(patternsInput, { target: { value: "*amex*, *statement*" } });

  // Submit form
  fireEvent.click(screen.getByRole("button", { name: "Create Profile" }));

  await waitFor(() => {
    expect(api.saveDocumentPassword).toHaveBeenCalledWith(
      "amex_statements",
      "Amex Statements",
      "secret123",
      "Credit card PDF statements",
      "Card ending 1234",
      ["*amex*", "*statement*"],
    );
  });

  expect(onChanged).toHaveBeenCalled();
  await waitFor(() => {
    expect(screen.getByText("Amex Statements")).toBeInTheDocument();
  });
});

test("edits an existing password profile without requiring password", async () => {
  const api = createMockApi();
  const onChanged = vi.fn();

  render(
    <PasswordManagerModal
      api={api}
      isOpen={true}
      onClose={vi.fn()}
      onChanged={onChanged}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Chase Bank Statements")).toBeInTheDocument();
  });

  const editButtons = screen.getAllByRole("button", { name: "Edit" });
  fireEvent.click(editButtons[0]!); // Edit Chase

  expect(
    screen.getByText(/Edit Profile: Chase Bank Statements/i),
  ).toBeInTheDocument();

  // Profile ID is disabled
  const idInput = screen.getByPlaceholderText(/bank_statements/i);
  expect(idInput).toBeDisabled();
  expect(idInput).toHaveValue("bank_chase");

  // Update label and hint
  const labelInput = screen.getByPlaceholderText(/Primary Bank Statements/i);
  fireEvent.change(labelInput, { target: { value: "Chase Premier Banking" } });

  const hintInput = screen.getByPlaceholderText(/Last 4 digits of tax ID/i);
  fireEvent.change(hintInput, { target: { value: "New Hint 9999" } });

  // Save changes (password left blank)
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => {
    expect(api.saveDocumentPassword).toHaveBeenCalledWith(
      "bank_chase",
      "Chase Premier Banking",
      undefined,
      "Monthly checking statements",
      "New Hint 9999",
      ["*chase*", "*statement*"],
    );
  });

  expect(onChanged).toHaveBeenCalled();
  await waitFor(() => {
    expect(screen.getByText("Chase Premier Banking")).toBeInTheDocument();
  });
});

test("deletes a password profile after confirmation", async () => {
  const api = createMockApi();
  const onChanged = vi.fn();

  render(
    <PasswordManagerModal
      api={api}
      isOpen={true}
      onClose={vi.fn()}
      onChanged={onChanged}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Chase Bank Statements")).toBeInTheDocument();
  });

  const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
  fireEvent.click(deleteButtons[0]!); // Click Delete on Chase

  // Confirmation appears
  expect(screen.getByText("Delete?")).toBeInTheDocument();
  const yesButton = screen.getByRole("button", { name: "Yes" });
  fireEvent.click(yesButton);

  await waitFor(() => {
    expect(api.deleteDocumentPassword).toHaveBeenCalledWith("bank_chase");
  });

  expect(onChanged).toHaveBeenCalled();
  await waitFor(() => {
    expect(screen.queryByText("Chase Bank Statements")).toBeNull();
  });
});

import { Renderer } from "@openuidev/react-lang";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { extractFormDataFromOpenUIEvent } from "../../shared/openui";
import { openliaLibrary, normalizeOpenUIProgram } from "./library";

const form = (id: string) => `Form(name: "finance-proposal-${id}", fields: [
  FormControl(label: "Action", input: RadioGroup(name: "action", items: [RadioItem(value: "confirm", label: "Confirm posting", description: "Explicit confirmation"), RadioItem(value: "cancel", label: "Cancel proposal", description: "No journal write")])),
  FormControl(label: "Proposal", input: Select(name: "proposal_id", value: "${id}", items: [SelectItem(value: "${id}", label: "${id}")])),
  FormControl(label: "Confirmation", input: Input(name: "confirmation"))
], buttons: Buttons(buttons: [Button(label: "Apply")]))`;

it("labels repeated forms and isolates their action, identity and confirmation state", async () => {
  const submit = vi.fn();
  render(
    <Renderer
      library={openliaLibrary}
      response={normalizeOpenUIProgram(
        `Stack(children: [${form("first")}, ${form("second")}])`,
      )}
      onAction={(event) =>
        submit({
          name: event.formName,
          data: extractFormDataFromOpenUIEvent(event),
        })
      }
    />,
  );
  const first = await screen.findByRole("group", {
    name: "finance-proposal-first",
  });
  const second = screen.getByRole("group", { name: "finance-proposal-second" });
  expect(submit).not.toHaveBeenCalled();
  expect(
    within(first)
      .getByRole("radio", { name: /^Confirm posting/ })
      .getAttribute("data-state"),
  ).toBe("unchecked");
  fireEvent.click(
    within(first).getByRole("radio", { name: /^Confirm posting/ }),
  );
  fireEvent.change(within(first).getByRole("textbox"), {
    target: { value: "POST" },
  });
  fireEvent.click(
    within(second).getByRole("radio", { name: /^Cancel proposal/ }),
  );
  expect(
    within(first)
      .getByRole("radio", { name: /^Confirm posting/ })
      .getAttribute("data-state"),
  ).toBe("checked");
  expect((within(second).getByRole("textbox") as HTMLInputElement).value).toBe(
    "",
  );
  fireEvent.click(within(first).getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith({
      name: "finance-proposal-first",
      data: expect.objectContaining({
        action: "confirm",
        proposal_id: "first",
        confirmation: "POST",
      }),
    }),
  );
  fireEvent.click(within(second).getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(submit).toHaveBeenLastCalledWith({
      name: "finance-proposal-second",
      data: expect.objectContaining({
        action: "cancel",
        proposal_id: "second",
      }),
    }),
  );
});

it("includes explicit initial values but never resets user edits or auto-submits", async () => {
  const submit = vi.fn();
  const response = normalizeOpenUIProgram(
    'Form(name: "example", fields: [FormControl(label: "Value", input: Input(name: "value", value: "Initial"))], buttons: Buttons(buttons: [Button(label: "Apply")]))',
  );
  render(
    <Renderer
      library={openliaLibrary}
      response={response}
      onAction={(event) => submit(extractFormDataFromOpenUIEvent(event))}
    />,
  );
  const control = await screen.findByRole("textbox");
  expect((control as HTMLInputElement).value).toBe("Initial");
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(control, { target: { value: "Edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ value: "Edited" }));
});

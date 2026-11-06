import { openuiLibrary } from "@openuidev/react-ui";
import { useGetFieldValue, useSetDefaultValue } from "@openuidev/react-lang";

const upstream = openuiLibrary.components.Form;
if (!upstream) throw new Error("The OpenUI Form component is unavailable");
const BaseForm = upstream.component;

function DefaultValue({
  formName,
  name,
  value,
}: {
  formName: string;
  name: string;
  value: unknown;
}) {
  const getFieldValue = useGetFieldValue();
  useSetDefaultValue({
    formName,
    componentType: "FormControl",
    name,
    existingValue: getFieldValue(formName, name),
    defaultValue: value,
  });
  return null;
}

/** Preserve upstream validation/state handling, but expose the form's identity
 * as an accessible group. Repeated forms must use distinct names: OpenUI keys
 * field state by form name, not by DOM position. Explicit field values are also
 * persisted after streaming so displayed defaults are included in submissions;
 * the upstream helper never replaces a value the user has already edited. */
export const NamedForm = {
  ...upstream,
  component: (args: Parameters<typeof BaseForm>[0]) => {
    const name = String(args.props.name);
    const fields = (args.props.fields ?? []) as {
      props?: { input?: { props?: { name?: unknown; value?: unknown } } };
    }[];
    return (
      <fieldset className="m-0 min-w-0 border-0 p-0" aria-label={name}>
        {fields
          .map((field) => field.props?.input?.props)
          .filter(
            (input) =>
              typeof input?.name === "string" && input.value !== undefined,
          )
          .map((input) => (
            <DefaultValue
              key={String(input?.name)}
              formName={name}
              name={String(input?.name)}
              value={input?.value}
            />
          ))}
        <BaseForm {...args} />
      </fieldset>
    );
  },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { MinionDataViews } from "../MinionDataViews";
import {
  minionViewDescriptionSchema,
  minionQueryResultSchema,
} from "../../shared/minionViews";

const description = minionViewDescriptionSchema.parse({
  schema: 1,
  id: "gym",
  revision: "sha256:story",
  settings: {},
  views: [
    {
      id: "sessions",
      label: "Sessions",
      reader: "json",
      path: "data/items.json",
      fields: ["item", "date"],
      title_field: "item",
      date_field: "date",
      briefing_enabled: false,
    },
  ],
});
const api = {
  describeMinionViews: async () => description,
  queryMinionView: async () =>
    minionQueryResultSchema.parse({
      schema: 1,
      status: "ok",
      id: "gym",
      view: "sessions",
      from: "2026-10-01",
      to: "2026-10-08",
      observed_at: "2026-10-02T12:00:00Z",
      revision: "sha256:story",
      records: [
        {
          id: "session",
          title: "Synthetic session",
          fields: { item: "Synthetic session", date: "2026-10-02" },
          source: "openlia://workspace/minions/gym/data/items.json",
        },
      ],
      matched: 2,
      unknown_dates: 0,
      truncated: true,
    }),
};
const meta = {
  title: "Minions/Shared data views",
  parameters: { componentExports: ["MinionDataViews.tsx#MinionDataViews"] },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReadOnly: Story = {
  render: () => <MinionDataViews id="gym" api={api} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Read view" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Synthetic session" }),
    ).toBeVisible();
  },
};
export const Unavailable: Story = {
  render: () => (
    <MinionDataViews
      id="gym"
      api={{
        describeMinionViews: async () => {
          throw new Error("Reader unavailable");
        },
      }}
    />
  ),
};

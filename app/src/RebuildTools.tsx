// The rebuild toolkit on "My club": one-click tools for a long-term save, sized to be sensible rather than to max
// everything out. Every tool works the same way: it reads the game now, shows exactly what it would change, and writes
// nothing until Apply is pressed. What it wrote can be undone from here, or later from the Changes view.
//
// The club tools write through `apply_edits`, one change per field. The young players' tool reads the club's squads
// (`club_squads`), leaves out players here on loan from another club, and extends each contract with
// `extend_contract`. Every change is logged on its own, and Undo takes them back with `undo_change`.
//
// The text is English only: this panel belongs to a personal fork and is not in the app's translation files.

import { useContext, useState } from "react";
import {
  applyEdits,
  clubSquads,
  dateFromNumber,
  editFields,
  extendContract,
  numberFromDate,
  plusYears,
  readValues,
  shownValue,
  storedValue,
  undoChange,
} from "./editing";
import { currencySymbol, describeError, formatDate, formatMoney } from "./format";
import { fieldLabel } from "./labels";
import { EditorContext } from "./useProfileEditing";
import type { EditField, FieldEdit, FmDate, SquadPlayer } from "./types";
import "./RebuildTools.css";

const FACILITIES: { key: string; label: string }[] = [
  { key: "facilities.training", label: "Training facilities" },
  { key: "facilities.youth_facilities", label: "Youth facilities" },
  { key: "facilities.youth_coaching", label: "Junior coaching" },
  { key: "facilities.youth_recruitment", label: "Youth recruitment" },
];

/** The youngest players' tool: who counts as young, how soon a contract must end, and how many years it adds. */
const YOUTH_MAX_AGE = 21;
const YOUTH_ENDING_YEARS = 2;
const YOUTH_EXTRA_YEARS = 3;

type ToolId = "facilities" | "debt" | "transfer" | "wages" | "youth";

interface Tool {
  id: ToolId;
  title: string;
  blurb: string;
}

const TOOLS: Tool[] = [
  {
    id: "facilities",
    title: "Upgrade facilities",
    blurb: "Training, youth facilities, junior coaching and youth recruitment each go up one step (up to 20).",
  },
  { id: "debt", title: "Clear the debt", blurb: "A negative bank balance is set to zero. Nothing changes if you're in credit." },
  { id: "transfer", title: "Add to transfer budget", blurb: "Adds the amount you choose to this season's transfer budget." },
  { id: "wages", title: "Raise wage budget", blurb: "Raises the weekly wage budget by the percentage you choose." },
  {
    id: "youth",
    title: "Tie down young players",
    blurb: `Players aged ${YOUTH_MAX_AGE} or under whose contracts end within ${YOUTH_ENDING_YEARS} years get ${YOUTH_EXTRA_YEARS} more years.`,
  },
];

/** One line of a club tool's preview: a field, what it holds and what it would hold, as stored. */
interface Row {
  label: string;
  field: EditField;
  old: number;
  new: number;
}

/** What a tool would do, before Apply. */
type Plan = { kind: "club"; tool: Tool; rows: Row[] } | { kind: "youth"; tool: Tool; players: SquadPlayer[] };

/** What a tool did, after Apply: the logged changes, to undo them, and what could not be written. */
interface Done {
  tool: Tool;
  ids: number[];
  failed: string[];
}

const clamp = (value: number, field: EditField) => Math.min(field.max, Math.max(field.min, value));

/** A stored value as the game shows it, for the preview. */
function shown(field: EditField, stored: number): string {
  if (field.kind === "i32") {
    return stored < 0 && field.key === "finance.transfer_budget" ? "Not set" : formatMoney(stored);
  }
  if (field.kind === "date") {
    return formatDate(dateFromNumber(stored));
  }
  return String(shownValue(field, stored));
}

interface RebuildToolsProps {
  clubUid: number;
  gameDate: FmDate | null;
}

export function RebuildTools({ clubUid, gameDate }: RebuildToolsProps) {
  const { editable, readOnlyNote, onEdited } = useContext(EditorContext);
  const [open, setOpen] = useState(false);
  const [transferAmount, setTransferAmount] = useState("1000000");
  const [wagePercent, setWagePercent] = useState("10");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (e) {
      setMessage(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  /** Reads the club now and works out the club tool's changes. */
  const planClub = async (tool: Tool): Promise<Row[]> => {
    const [fields, values] = await Promise.all([editFields("club"), readValues("club", clubUid)]);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const rows: Row[] = [];
    const push = (key: string, label: string, next: (old: number, field: EditField) => number) => {
      const field = byKey.get(key);
      const old = values[key];
      if (!field || old === undefined) {
        return;
      }
      const value = clamp(next(old, field), field);
      if (value !== old) {
        rows.push({ label, field, old, new: value });
      }
    };
    switch (tool.id) {
      case "facilities":
        for (const { key, label } of FACILITIES) {
          push(key, label, (old, field) => storedValue(field, shownValue(field, old) + 1));
        }
        break;
      case "debt":
        push("finance.balance", "Bank balance", (old) => (old < 0 ? 0 : old));
        break;
      case "transfer": {
        const amount = Number(transferAmount.replace(/[^\d.]/g, ""));
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error("Type an amount above zero.");
        }
        push("finance.transfer_budget", "Transfer budget", (old, field) => {
          // -1 means the board has set no transfer budget: start from nothing.
          const base = Math.max(0, old);
          return base + storedValue(field, amount);
        });
        break;
      }
      case "wages": {
        const percent = Number(wagePercent);
        if (!Number.isFinite(percent) || percent <= 0 || percent > 200) {
          throw new Error("Type a percentage between 1 and 200.");
        }
        const raise = (old: number) => Math.round((old * (100 + percent)) / 100);
        push("finance.total_wage_budget", `${fieldLabel("club", "finance.total_wage_budget")} (per week)`, raise);
        push("finance.wage_budget", fieldLabel("club", "finance.wage_budget"), raise);
        break;
      }
      case "youth":
        break;
    }
    return rows;
  };

  const preview = (tool: Tool) =>
    run(async () => {
      setDone(null);
      if (tool.id === "youth") {
        if (gameDate === null) {
          throw new Error("The game's date could not be read, so contract end dates can't be checked.");
        }
        const limit = numberFromDate(plusYears(gameDate, YOUTH_ENDING_YEARS));
        const seen = new Set<number>();
        const players: SquadPlayer[] = [];
        for (const team of await clubSquads(clubUid)) {
          for (const player of team.players) {
            const ends = player.contractExpires ? numberFromDate(player.contractExpires) : null;
            // Players here on loan belong to another club: their contracts are not this club's to extend.
            if (
              !seen.has(player.uid) &&
              player.loan !== "in" &&
              player.age !== null &&
              player.age <= YOUTH_MAX_AGE &&
              ends !== null &&
              ends <= limit
            ) {
              seen.add(player.uid);
              players.push(player);
            }
          }
        }
        players.sort((a, b) => numberFromDate(a.contractExpires!) - numberFromDate(b.contractExpires!));
        setPlan({ kind: "youth", tool, players });
      } else {
        setPlan({ kind: "club", tool, rows: await planClub(tool) });
      }
    });

  const apply = () =>
    run(async () => {
      if (!plan) {
        return;
      }
      if (plan.kind === "club") {
        const edits: FieldEdit[] = plan.rows.map((row) => ({ field: row.field.key, value: row.new }));
        const report = await applyEdits("club", clubUid, edits);
        setDone({
          tool: plan.tool,
          ids: report.applied.map((change) => change.id),
          failed: report.failed.map((f) => f.error.message),
        });
      } else {
        const ids: number[] = [];
        const failed: string[] = [];
        for (const player of plan.players) {
          try {
            ids.push((await extendContract("player", player.uid, YOUTH_EXTRA_YEARS)).id);
          } catch (e) {
            failed.push(`${player.name}: ${describeError(e)}`);
          }
        }
        setDone({ tool: plan.tool, ids, failed });
      }
      setPlan(null);
      onEdited();
    });

  const undo = () =>
    run(async () => {
      if (!done) {
        return;
      }
      // Newest first, so a field changed twice ends where it started.
      for (const id of [...done.ids].reverse()) {
        await undoChange(id);
      }
      setDone(null);
      setMessage(`Undid "${done.tool.title}".`);
      onEdited();
    });

  const changeCount = plan ? (plan.kind === "club" ? plan.rows.length : plan.players.length) : 0;

  return (
    <section className="rebuild" aria-label="Rebuild toolkit">
      <div className="rebuild-head">
        <div>
          <h3>Rebuild toolkit</h3>
          <p className="muted">One-click help for a long-term save. Every tool shows its changes first, and can be undone.</p>
        </div>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show tools"}
        </button>
      </div>

      {open && (
        <>
          {!editable && <p className="banner">{readOnlyNote || "Editing is turned off for this version of the game."}</p>}

          <div className="rebuild-tools">
            {TOOLS.map((tool) => (
              <div key={tool.id} className="rebuild-tool">
                <h4>{tool.title}</h4>
                <p className="muted">{tool.blurb}</p>
                {tool.id === "transfer" && (
                  <label className="rebuild-input">
                    Amount ({currencySymbol})
                    <input
                      inputMode="numeric"
                      value={transferAmount}
                      onChange={(e) => setTransferAmount(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                )}
                {tool.id === "wages" && (
                  <label className="rebuild-input">
                    Raise by (%)
                    <input
                      inputMode="numeric"
                      value={wagePercent}
                      onChange={(e) => setWagePercent(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={!editable || busy}
                  title={!editable ? readOnlyNote : undefined}
                  onClick={() => void preview(tool)}
                >
                  Preview
                </button>
              </div>
            ))}
          </div>

          {message && (
            <p className="rebuild-message" role="status">
              {message}
            </p>
          )}

          {plan && (
            <div className="rebuild-plan" role="region" aria-label={`Preview: ${plan.tool.title}`}>
              <h4>{plan.tool.title}: preview</h4>
              {changeCount === 0 ? (
                <p className="muted">
                  {plan.kind === "youth"
                    ? `No players at your club aged ${YOUTH_MAX_AGE} or under have contracts ending within ${YOUTH_ENDING_YEARS} years.`
                    : "Nothing to change: everything is already where this tool would put it."}
                </p>
              ) : plan.kind === "club" ? (
                <table>
                  <thead>
                    <tr>
                      <th>What</th>
                      <th>Now</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.rows.map((row) => (
                      <tr key={row.field.key}>
                        <td>{row.label}</td>
                        <td className="figure">{shown(row.field, row.old)}</td>
                        <td className="figure">{shown(row.field, row.new)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <>
                  <p className="muted">
                    {plan.players.length} contract{plan.players.length === 1 ? "" : "s"} would be extended by{" "}
                    {YOUTH_EXTRA_YEARS} years. Players here on loan from other clubs are left out.
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Contract ends now</th>
                        <th>After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.players.map((player) => (
                        <tr key={player.uid}>
                          <td>
                            {player.name} ({player.age})
                          </td>
                          <td className="figure">{formatDate(player.contractExpires)}</td>
                          <td className="figure">
                            {player.contractExpires && formatDate(plusYears(player.contractExpires, YOUTH_EXTRA_YEARS))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <div className="rebuild-buttons">
                <button type="button" className="primary" disabled={busy || changeCount === 0} onClick={() => void apply()}>
                  Apply
                </button>
                <button type="button" disabled={busy} onClick={() => setPlan(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {done && (
            <div className="rebuild-done" role="status">
              <p>
                {done.tool.title}: done.{" "}
                {`${done.ids.length} change${done.ids.length === 1 ? "" : "s"} written.`}{" "}
                Press Continue in FM to see it in the game.
              </p>
              {done.failed.length > 0 && <p className="error">Not written: {done.failed.join("; ")}</p>}
              <button type="button" disabled={busy} onClick={() => void undo()}>
                Undo
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

import React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** Responsive table: real <table> on md+, stacked cards below. */
export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  className?: string;
  align?: "left" | "right";
  /** Hide in mobile card view. */
  hideOnMobile?: boolean;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowHref,
  caption,
  mobileTitle,
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowHref?: (row: T) => string;
  caption: string;
  mobileTitle?: (row: T) => React.ReactNode;
  empty?: React.ReactNode;
}) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn("whitespace-nowrap px-4 py-2.5 text-label font-medium text-foreground-secondary first:pl-5 last:pr-5", c.align === "right" ? "text-right" : "text-left", c.className)}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={rowKey(r)} className="group relative transition-colors hover:bg-surface-2/60">
                {columns.map((c, i) => (
                  <td key={c.key} className={cn("px-4 py-3 align-middle first:pl-5 last:pr-5", c.align === "right" && "text-right", c.className)}>
                    {i === 0 && onRowHref ? (
                      <Link href={onRowHref(r)} className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-gold">
                        {c.cell(r)}
                      </Link>
                    ) : (
                      c.cell(r)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-border md:hidden" aria-label={caption}>
        {rows.map((r) => {
          const body = (
            <div className="space-y-1.5 px-4 py-3.5">
              {mobileTitle && <div className="text-[14px] font-medium text-foreground">{mobileTitle(r)}</div>}
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {columns
                  .filter((c) => !c.hideOnMobile)
                  .map((c) => (
                    <div key={c.key} className="min-w-0">
                      <dt className="text-micro text-foreground-muted">{c.header}</dt>
                      <dd className="min-w-0 truncate text-[13px] text-foreground">{c.cell(r)}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          );
          return (
            <li key={rowKey(r)}>
              {onRowHref ? (
                <Link href={onRowHref(r)} className="block hover:bg-surface-2/60">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

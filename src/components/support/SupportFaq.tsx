"use client";
import { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { SUPPORT_FAQ } from "@/lib/support/faq";

export function SupportFaq() {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const questions = SUPPORT_FAQ.filter((item) =>
    `${item.category} ${item.question} ${item.answer}`
      .toLowerCase()
      .includes(query),
  );
  return (
    <section
      className="vx-admin-panel"
      style={{ marginBottom: 24 }}
      aria-labelledby="support-faq-title"
    >
      <h2 id="support-faq-title">Help center</h2>
      <p className="dim">
        Find an answer, or open a request below for help with your account.
      </p>
      <label className="vx-admin-row" style={{ marginBottom: 16 }}>
        <Search size={16} />
        <input
          type="search"
          aria-label="Search help articles"
          placeholder="Search help articles…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {!questions.length ? (
        <p className="dim">
          No matching answers. You can ask our support team below.
        </p>
      ) : (
        questions.map((item) => (
          <details key={item.question} className="vx-support-faq">
            <summary>
              {item.question}
              <span className="dim">{item.category}</span>
            </summary>
            <p className="dim">{item.answer}</p>
            {"href" in item && <Link href={item.href}>{item.link} →</Link>}
          </details>
        ))
      )}
    </section>
  );
}

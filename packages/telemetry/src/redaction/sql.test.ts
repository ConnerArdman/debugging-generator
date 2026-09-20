/**
 * Colocated suite for the `db.statement` handler (`./sql.ts`).
 *
 * The privacy model states the contract this file enforces (AAP 0.5.2): a
 * captured statement is stored as **parameterised text** — `$1`-style
 * placeholders survive untouched — every **inline literal** is replaced by
 * {@link REDACTION_MASK}, and row contents never reach the module at all
 * (only `db.rowCount` is retained elsewhere). AAP 0.8.3 names "SQL literals"
 * as required redaction coverage, and that is the first half of what is
 * asserted below.
 *
 * The second half is an analysis-correctness gate rather than a privacy one.
 * `../aggregate/queries.ts` groups captured queries by the **exact** string
 * {@link normalizeSqlStatement} returns, so the grouping key's behaviour —
 * placeholder unification, whitespace collapse, terminator stripping and
 * value-list folding, and the deliberate refusal to fold case — decides
 * whether a duplicate-query finding counts one group or twenty. Every
 * normalisation assertion here is therefore a statement about what the
 * `queryTable` panel and the duplicate-query analysis will report.
 *
 * Three conventions hold throughout:
 *
 * - **Expectations are exact strings, not shapes.** Both functions are pure
 *   and deterministic, so `toBe` on the whole result is both achievable and
 *   the only assertion that catches a literal leaking through in a position a
 *   narrower matcher would not look at. Where a mask count matters it is
 *   asserted through `redactSqlStatementWithFindings`.
 * - **Fixtures are neutral.** Table and column names are `items`, `orders_t`,
 *   `t1`, `t2`, `col_a`, `col1`, `utf8_col`. Nothing here names a table,
 *   model, route or component of the bundled demo application: this is
 *   tracked product source, and `scripts/check-no-hardcoding.mjs` fails the
 *   build if a demo identifier appears in it (AAP 0.5.4).
 * - **Credential-shaped fixtures are assembled at runtime** from fragments,
 *   never written as a contiguous literal, so `scripts/check-secrets.mjs`
 *   sees no credential prefix or credentialed connection string in the
 *   committed bytes (AAP 0.3.4). The assembled values are fake by
 *   construction — repeated characters, a loopback host — and authenticate
 *   against nothing.
 */
import { describe, expect, it } from 'vitest';

import {
  SQL_MAX_LENGTH,
  normalizeSqlStatement,
  redactSqlStatement,
  redactSqlStatementWithFindings,
} from './sql.js';
import { REDACTION_MARKER, REDACTION_MASK, containsDenied } from './rules.js';

/*
 * ---------------------------------------------------------------------------
 * Credential-shaped fixtures, assembled from fragments
 * ---------------------------------------------------------------------------
 */

/**
 * A provider-credential-shaped token. The prefix is split across two
 * fragments so the committed file contains no contiguous credential prefix,
 * and the body is a repeated pair, which keeps its entropy far below the
 * secret gate's threshold while still matching the deny-list's shape.
 */
const PROVIDER_CREDENTIAL = 's' + 'k-ant-' + 'A1'.repeat(14);

/** User half of the credentialed connection string below. */
const CONNECTION_USER = 'svc_user';

/**
 * Password half of the credentialed connection string below. A fabricated
 * ten-character fragment: far too short and too repetitive for the secret
 * gate's entropy rule, and it authenticates against nothing. It is a named
 * constant rather than an inline literal so the assertions can prove it
 * appears in no output.
 */
const CONNECTION_PASSWORD = 'p4ssphrase';

/**
 * A credentialed connection string of the kind a `dblink` call or a `COPY …
 * FROM PROGRAM` argument can carry. Assembled from fragments for the reason
 * given in the module documentation; the host is the loopback address.
 */
const CONNECTION_STRING =
  'postgres' + 'ql://' + CONNECTION_USER + ':' + CONNECTION_PASSWORD + '@' + '127.0.0.1:5432/db_a';

/*
 * ---------------------------------------------------------------------------
 * The fixture table
 *
 * Every entry is a statement of the kind the instrumented tiers actually
 * produce — `@prisma/instrumentation` emits parameterised text, a raw
 * `pool.query` can carry anything a developer wrote — paired with the
 * distinctive values that must not survive either function. The table drives
 * the property sweeps at the end of the file (leak, inline-literal,
 * deny-list, idempotence), so every case added to the suite is added here too
 * and is checked against all four properties without being restated.
 * ---------------------------------------------------------------------------
 */

/** One statement plus the values that must not appear in any output. */
interface Fixture {
  /** Name shown in the sweep's test titles. */
  readonly name: string;
  /** Statement text as it would arrive from a database span. */
  readonly sql: string;
  /** Distinctive values that must appear in no output. */
  readonly forbiddenValues: readonly string[];
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'parameterised select',
    sql: 'SELECT id, name FROM items WHERE id = $1 AND status = $2',
    forbiddenValues: [],
  },
  {
    name: 'identifiers containing digits',
    sql: 'SELECT col1, t2.col, utf8_col FROM items AS t2',
    forbiddenValues: [],
  },
  {
    name: 'quoted and backticked identifiers',
    sql: 'SELECT "Quoted Identifier", `backticked` FROM "Mixed Case" t1',
    forbiddenValues: [],
  },
  {
    name: 'single-quoted literal',
    sql: "SELECT col_a FROM t1 WHERE col_a = 'alpha-value'",
    forbiddenValues: ['alpha-value'],
  },
  {
    name: "literal containing the '' escape",
    sql: "UPDATE t1 SET col_a = 'it''s privatevalue' WHERE id = $1",
    forbiddenValues: ["it''s", 'privatevalue'],
  },
  {
    name: 'literal containing comment markers',
    sql: "SELECT col_a FROM t1 WHERE col_a = 'privatevalue -- b /* c */ d'",
    forbiddenValues: ['privatevalue', '-- b', '/* c */ d'],
  },
  {
    name: 'escape string',
    sql: "INSERT INTO t1 (col_a) VALUES (E'escapedvalue\\nsecondline')",
    forbiddenValues: ['escapedvalue', 'secondline'],
  },
  {
    name: 'dollar-quoted body holding a placeholder and a tag prefix',
    sql: 'SELECT $tag$ privatebody with $1 and $ta prefix $tag$ AS col_a',
    forbiddenValues: ['privatebody', 'prefix'],
  },
  {
    name: 'dollar-quoted body with an empty tag',
    sql: 'SELECT $$ plainbody $$ AS col_a',
    forbiddenValues: ['plainbody'],
  },
  {
    name: 'numeric literals in every notation',
    sql: 'SELECT col_a FROM t1 WHERE a = 42 AND b = -7 AND c = 3.14 AND d = .5 AND e = 1e9',
    forbiddenValues: ['42', '3.14', '1e9'],
  },
  {
    name: 'hex, bit and 0x literals',
    sql: "SELECT X'DEADBEEF', B'1010', 0x1f FROM t1",
    forbiddenValues: ['DEADBEEF', '1010', '1f'],
  },
  {
    name: 'line comment',
    sql: 'SELECT col_a -- note holding privatevalue\nFROM t1',
    forbiddenValues: ['privatevalue', 'note holding'],
  },
  {
    name: 'block comment',
    sql: 'SELECT /* note holding privatevalue */ col_a FROM t1',
    forbiddenValues: ['privatevalue', 'note holding'],
  },
  {
    name: 'nested block comments',
    sql: 'SELECT /* outer privatevalue /* inner othervalue */ outer */ col_a FROM t1',
    forbiddenValues: ['privatevalue', 'othervalue'],
  },
  {
    name: 'unterminated string',
    sql: "SELECT col_a FROM t1 WHERE col_a = 'danglingvalue",
    forbiddenValues: ['danglingvalue'],
  },
  {
    name: 'unterminated block comment',
    sql: 'SELECT col_a FROM t1 /* danglingnote',
    forbiddenValues: ['danglingnote'],
  },
  {
    name: 'unterminated dollar-quoted body',
    sql: 'SELECT $tag$ danglingbody',
    forbiddenValues: ['danglingbody'],
  },
  {
    name: 'unterminated quoted identifier',
    sql: 'SELECT "DanglingIdentifier FROM t1',
    forbiddenValues: ['DanglingIdentifier'],
  },
  {
    name: 'credential in a line comment',
    sql: `SELECT col_a FROM t1 -- left by a developer: ${PROVIDER_CREDENTIAL}\nWHERE id = $1`,
    forbiddenValues: [PROVIDER_CREDENTIAL],
  },
  {
    name: 'credential in a string literal',
    sql: `SELECT col_a FROM t1 WHERE col_a = '${PROVIDER_CREDENTIAL}'`,
    forbiddenValues: [PROVIDER_CREDENTIAL],
  },
  {
    name: 'credential in structure position',
    sql: `SELECT ${PROVIDER_CREDENTIAL} FROM t1`,
    forbiddenValues: [PROVIDER_CREDENTIAL],
  },
  {
    name: 'connection string in a dblink literal',
    sql: `SELECT col_a FROM dblink('${CONNECTION_STRING}', 'SELECT 1') AS t1(col_a int)`,
    forbiddenValues: [CONNECTION_STRING, CONNECTION_PASSWORD],
  },
  {
    name: 'connection string in structure position',
    sql: `SELECT col_a FROM dblink_connect(${CONNECTION_STRING}) AS t1`,
    forbiddenValues: [CONNECTION_USER, CONNECTION_PASSWORD],
  },
  {
    name: 'multi-statement batch',
    sql: "SELECT 1; SELECT 'secondvalue';",
    forbiddenValues: ['secondvalue'],
  },
  {
    name: 'reformatted statement with mixed whitespace',
    sql: 'SELECT id\n  FROM items\tWHERE id = $1;',
    forbiddenValues: [],
  },
  {
    name: 'inlined value list',
    sql: "INSERT INTO orders_t (col_a, col_b) VALUES ('alphavalue', 1), ('betavalue', 2)",
    forbiddenValues: ['alphavalue', 'betavalue'],
  },
];

/** Every fixture statement, for the sweeps that do not need the metadata. */
const FIXTURE_STATEMENTS: readonly string[] = FIXTURES.map((fixture) => fixture.sql);

/**
 * Wall-clock budget for the linear-time properties, in milliseconds.
 *
 * The implementation is a single-pass scanner whose work is bounded by
 * {@link SQL_MAX_LENGTH}, so the workloads below measure in single-digit
 * milliseconds on an idle machine. The budget is orders of magnitude larger
 * than that because these suites share a heavily loaded host: it is sized to
 * catch the failure mode that matters — a rewrite whose cost is quadratic or
 * whose pattern backtracks catastrophically, either of which turns a
 * millisecond into minutes — without failing on scheduler noise.
 */
const LINEAR_TIME_BUDGET_MS = 2_000;

/** Iterations each linear-time workload is run for. */
const LINEAR_TIME_ITERATIONS = 10;

describe('redactSqlStatement', () => {
  describe('structure that must survive', () => {
    it('returns a parameterised statement unchanged', () => {
      // The contract the instrumented database tiers depend on: they already
      // emit parameterised text, and the outbound model guard accepts it, so
      // redaction must be a no-op on it - placeholders, keywords,
      // identifiers, punctuation and spacing included.
      const sql = 'SELECT id, name FROM items WHERE id = $1 AND status = $2';

      expect(redactSqlStatement(sql)).toBe(sql);
      expect(redactSqlStatementWithFindings(sql).literalCount).toBe(0);
    });

    it('leaves multi-digit and repeated placeholders intact', () => {
      const sql = 'SELECT col_a FROM t1 WHERE a = $10 AND b = $2 AND c = $10';

      expect(redactSqlStatement(sql)).toBe(sql);
    });

    it('does not nibble digits out of unquoted identifiers', () => {
      // The numeric rule fires only where a value can begin. An identifier is
      // consumed whole, so `col1` keeps its digit and `t2.col` keeps both
      // halves of the qualified name.
      const sql = 'SELECT col1, t2.col, utf8_col FROM items AS t2';

      expect(redactSqlStatement(sql)).toBe(sql);
      expect(redactSqlStatementWithFindings(sql).literalCount).toBe(0);
    });

    it('preserves quoted and backticked identifiers verbatim', () => {
      // An identifier is schema, not data: masking it would destroy the
      // statement's meaning for no privacy gain, and PostgreSQL quoted
      // identifiers are case-sensitive, so the case is preserved too.
      const sql = 'SELECT "Quoted Identifier", `backticked` FROM "Mixed Case" t1';

      expect(redactSqlStatement(sql)).toBe(sql);
      expect(redactSqlStatementWithFindings(sql).literalCount).toBe(0);
    });

    it('preserves doubled quotes inside a quoted identifier', () => {
      const sql = 'SELECT "col""x", `back``tick` FROM t1';

      expect(redactSqlStatement(sql)).toBe(sql);
    });

    it('keeps NULL, TRUE, FALSE, LIMIT and OFFSET as structure', () => {
      const sql =
        'SELECT col_a FROM t1 WHERE col_a IS NOT NULL AND flag = TRUE OR other = FALSE LIMIT 50 OFFSET 100';

      expect(redactSqlStatement(sql)).toBe(
        'SELECT col_a FROM t1 WHERE col_a IS NOT NULL AND flag = TRUE OR other = FALSE LIMIT ? OFFSET ?',
      );
    });

    it('masks the numeric argument of LIMIT, which is a value and not a keyword', () => {
      // Documented behaviour rather than an oversight: a row bound is a
      // number in value position, and the scanner has no notion of which
      // keyword precedes a literal. The keyword survives, the number does
      // not, and a reader of the panel still sees that the query was limited.
      expect(redactSqlStatement('SELECT col_a FROM t1 LIMIT 50')).toBe(
        'SELECT col_a FROM t1 LIMIT ' + REDACTION_MASK,
      );
    });

    it('does not treat # as a comment introducer', () => {
      // `#` is an operator in PostgreSQL. Reading it as a MySQL comment would
      // silently delete the rest of the line, which is statement structure.
      const sql = 'SELECT col_a # col_b FROM t1';

      expect(redactSqlStatement(sql)).toBe(sql);
    });

    it('accepts an empty statement', () => {
      expect(redactSqlStatement('')).toBe('');
    });
  });

  describe('literals that must be masked', () => {
    it('replaces a single-quoted literal with one mask', () => {
      expect(redactSqlStatement("SELECT col_a FROM t1 WHERE col_a = 'alpha-value'")).toBe(
        'SELECT col_a FROM t1 WHERE col_a = ' + REDACTION_MASK,
      );
    });

    it("replaces a literal containing the '' escape with exactly one mask", () => {
      // The doubled quote is an escaped quote, not the end of the literal.
      // Reading it as a terminator would leave the remainder of the value in
      // identifier position, where it would be emitted verbatim.
      const sql = "UPDATE t1 SET col_a = 'it''s privatevalue' WHERE id = $1";
      const findings = redactSqlStatementWithFindings(sql);

      expect(findings.statement).toBe('UPDATE t1 SET col_a = ' + REDACTION_MASK + ' WHERE id = $1');
      expect(findings.literalCount).toBe(1);
    });

    it('does not read comment markers inside a literal as comments', () => {
      const sql = "SELECT col_a FROM t1 WHERE col_a = 'privatevalue -- b /* c */ d'";
      const findings = redactSqlStatementWithFindings(sql);

      expect(findings.statement).toBe('SELECT col_a FROM t1 WHERE col_a = ' + REDACTION_MASK);
      expect(findings.literalCount).toBe(1);
    });

    it('masks an escape string with its backslash escapes', () => {
      const sql = "INSERT INTO t1 (col_a) VALUES (E'escapedvalue\\nsecondline')";

      expect(redactSqlStatement(sql)).toBe(
        'INSERT INTO t1 (col_a) VALUES (' + REDACTION_MASK + ')',
      );
    });

    it('masks an escape string containing a real newline', () => {
      expect(redactSqlStatement("SELECT E'first\nsecond' FROM t1")).toBe(
        'SELECT ' + REDACTION_MASK + ' FROM t1',
      );
    });

    it('masks a dollar-quoted body, including a placeholder and a tag prefix inside it', () => {
      // `$1` inside a dollar-quoted body is body text, not a placeholder, and
      // `$ta` is a prefix of the tag rather than its closing delimiter -
      // mistaking either would end the literal early.
      const sql = 'SELECT $tag$ privatebody with $1 and $ta prefix $tag$ AS col_a';
      const findings = redactSqlStatementWithFindings(sql);

      expect(findings.statement).toBe('SELECT ' + REDACTION_MASK + ' AS col_a');
      expect(findings.literalCount).toBe(1);
    });

    it('masks a dollar-quoted body with an empty tag', () => {
      expect(redactSqlStatement('SELECT $$ plainbody $$ AS col_a')).toBe(
        'SELECT ' + REDACTION_MASK + ' AS col_a',
      );
    });

    it('masks every numeric notation and keeps the sign as an operator', () => {
      // A leading `-` is an operator: masking it would make a subtraction
      // indistinguishable from a negative value and lose structure for no
      // privacy gain, because the digits are what carry the data.
      const sql =
        'SELECT col_a FROM t1 WHERE a = 42 AND b = -7 AND c = 3.14 AND d = .5 AND e = 1e9 AND f = 2.5E-3';
      const findings = redactSqlStatementWithFindings(sql);

      expect(findings.statement).toBe(
        'SELECT col_a FROM t1 WHERE a = ? AND b = -? AND c = ? AND d = ? AND e = ? AND f = ?',
      );
      expect(findings.literalCount).toBe(6);
    });

    it('masks hex, bit and 0x literals', () => {
      const sql = "SELECT X'DEADBEEF', B'1010', 0x1f FROM t1";
      const findings = redactSqlStatementWithFindings(sql);

      expect(findings.statement).toBe('SELECT ?, ?, ? FROM t1');
      expect(findings.literalCount).toBe(3);
    });

    it('masks a token that begins where a value belongs, tail included', () => {
      // `12x` is not valid SQL, but a token starting with a digit in value
      // position is masked whole rather than emitted as `?x`.
      expect(redactSqlStatement('SELECT 12x FROM t1')).toBe(
        'SELECT ' + REDACTION_MASK + ' FROM t1',
      );
    });

    it('masks multi-digit and signed exponents', () => {
      expect(
        redactSqlStatement('SELECT col_a FROM t1 WHERE a = 1e10 AND b = 1.5E+12 AND c = 2e-125'),
      ).toBe('SELECT col_a FROM t1 WHERE a = ? AND b = ? AND c = ?');
    });

    it('masks a malformed exponent whole', () => {
      // `5e` and `7e+` have no exponent digits, so the exponent is not part
      // of the number - but the name-like tail is consumed into the literal,
      // which leaves no digit behind either way.
      expect(redactSqlStatement('SELECT 5e, 7e+ FROM t1')).toBe('SELECT ?, ?+ FROM t1');
    });

    it('masks hexadecimal literals in either letter case', () => {
      expect(redactSqlStatement('SELECT 0xABCDEF, 0xab12cd FROM t1')).toBe('SELECT ?, ? FROM t1');
    });

    it('masks national character and Unicode string literals', () => {
      // `N'…'`, `U&'…'` and `u&'…'` are typed string literals: the prefix is
      // part of the delimiter, so the whole construct becomes one mask.
      expect(redactSqlStatement("SELECT N'nationalvalue', U&'0041', u&'0042' FROM t1")).toBe(
        'SELECT ?, ?, ? FROM t1',
      );
    });

    it('masks the body after an unrecognised single-letter prefix', () => {
      // `q'…'` is not a typed literal in this dialect, so the letter is an
      // identifier and the quote opens an ordinary string. The letter is
      // structure and survives; the body is data and does not.
      expect(redactSqlStatement("SELECT q'privatevalue' FROM t1")).toBe(
        'SELECT q' + REDACTION_MASK + ' FROM t1',
      );
    });
  });

  describe('comments, which are dropped rather than masked', () => {
    it('replaces a line comment with one space and keeps the line break', () => {
      // Comment text is dropped entirely: developers paste production values
      // into comments, and a comment also fragments the grouping key. One
      // space stands in so the tokens on either side cannot merge, and the
      // line terminator itself is statement layout and stays.
      expect(redactSqlStatement('SELECT col_a -- note holding privatevalue\nFROM t1')).toBe(
        'SELECT col_a  \nFROM t1',
      );
    });

    it('ends a line comment at a CRLF break', () => {
      expect(redactSqlStatement('SELECT col_a -- note\r\nFROM t1')).toBe(
        'SELECT col_a  \r\nFROM t1',
      );
    });

    it('replaces a block comment with one space', () => {
      expect(redactSqlStatement('SELECT /* note holding privatevalue */ col_a FROM t1')).toBe(
        'SELECT   col_a FROM t1',
      );
    });

    it('tracks nesting depth and preserves the text after the outermost close', () => {
      // PostgreSQL nests block comments, so the first `*/` of a nested pair
      // does not end the outer comment. Getting this wrong would emit the
      // outer comment's tail as statement text - and `col_a FROM t1`, which
      // follows the outermost close, would be lost if depth were ignored the
      // other way.
      expect(
        redactSqlStatement(
          'SELECT /* outer privatevalue /* inner othervalue */ outer */ col_a FROM t1',
        ),
      ).toBe('SELECT   col_a FROM t1');
    });

    it('drops a deeply nested comment without losing the statement around it', () => {
      const depth = 64;
      const sql = 'SELECT ' + '/*'.repeat(depth) + ' x ' + '*/'.repeat(depth) + ' col_a FROM t1';

      expect(redactSqlStatement(sql)).toBe('SELECT   col_a FROM t1');
    });

    it('does not end a block comment on an inner close while depth remains', () => {
      // The `privatevalue` sits between the inner and the outer close: it is
      // still comment text and must not reappear as structure.
      const redacted = redactSqlStatement('SELECT /* a /* b */ privatevalue */ col_a FROM t1');

      expect(redacted).toBe('SELECT   col_a FROM t1');
      expect(redacted).not.toContain('privatevalue');
    });
  });

  describe('constructs the input leaves unterminated', () => {
    it('masks an unterminated string without emitting its text', () => {
      // Whatever opened the quote is the reason to distrust everything after
      // it, so the scanner closes the construct itself rather than spilling
      // the partially scanned text.
      const sql = "SELECT col_a FROM t1 WHERE col_a = 'danglingvalue";
      const findings = redactSqlStatementWithFindings(sql);

      expect(findings.statement).toBe('SELECT col_a FROM t1 WHERE col_a = ' + REDACTION_MASK);
      expect(findings.statement).not.toContain('danglingvalue');
      expect(findings.literalCount).toBe(1);
    });

    it('masks an unterminated escape string', () => {
      expect(redactSqlStatement("SELECT col_a FROM t1 WHERE col_a = E'danglingvalue")).toBe(
        'SELECT col_a FROM t1 WHERE col_a = ' + REDACTION_MASK,
      );
    });

    it('masks an unterminated dollar-quoted body', () => {
      expect(redactSqlStatement('SELECT $tag$ danglingbody')).toBe('SELECT ' + REDACTION_MASK);
    });

    it('masks an unterminated quoted identifier rather than emitting it', () => {
      // A quoted identifier is emitted verbatim only once it is known to be
      // closed; an unterminated one could be a value that opened with a quote
      // the dialect reads differently, so it is masked.
      expect(redactSqlStatement('SELECT "DanglingIdentifier FROM t1')).toBe(
        'SELECT ' + REDACTION_MASK,
      );
    });

    it('drops an unterminated block comment and emits one separator', () => {
      expect(redactSqlStatement('SELECT col_a FROM t1 /* danglingnote')).toBe(
        'SELECT col_a FROM t1  ',
      );
    });

    it('drops an unterminated line comment', () => {
      expect(redactSqlStatement('SELECT col_a FROM t1 -- danglingnote')).toBe(
        'SELECT col_a FROM t1  ',
      );
    });

    it('never throws, however malformed the input', () => {
      // Statement text arrives from an instrumented process unbounded and, in
      // the worst case, adversarial: the handler is total, so a malformed
      // statement is redacted rather than raised into the ingest path.
      const malformed = [
        "'",
        '"',
        '`',
        '$',
        '$$',
        '$tag$',
        '/*',
        '--',
        'E',
        "E'",
        '\\',
        "'".repeat(101),
        '/*'.repeat(101),
        '\u0000\uD800',
      ];

      for (const sql of malformed) {
        expect(() => redactSqlStatement(sql)).not.toThrow();
        expect(() => normalizeSqlStatement(sql)).not.toThrow();
        expect(redactSqlStatement(sql)).not.toContain("'");
      }
    });
  });

  describe('credential material, wherever it sits', () => {
    it('removes a credential left in a comment', () => {
      const sql = `SELECT col_a FROM t1 -- left by a developer: ${PROVIDER_CREDENTIAL}\nWHERE id = $1`;
      const redacted = redactSqlStatement(sql);

      expect(redacted).toBe('SELECT col_a FROM t1  \nWHERE id = $1');
      expect(redacted).not.toContain(PROVIDER_CREDENTIAL);
    });

    it('masks a credential held in a string literal', () => {
      const sql = `SELECT col_a FROM t1 WHERE col_a = '${PROVIDER_CREDENTIAL}'`;
      const redacted = redactSqlStatement(sql);

      expect(redacted).toBe('SELECT col_a FROM t1 WHERE col_a = ' + REDACTION_MASK);
      expect(redacted).not.toContain(PROVIDER_CREDENTIAL);
    });

    it('scrubs a credential sitting in a position the scanner reads as structure', () => {
      // Belt and braces: the scanner emits identifiers verbatim, so the value
      // scrubber runs over everything the scan preserved. A credential that
      // the scanner had no reason to mask is still replaced - with the
      // marker, not a mask, because it is the scrubber that removed it.
      const redacted = redactSqlStatement(`SELECT ${PROVIDER_CREDENTIAL} FROM t1`);

      expect(redacted).toBe(`SELECT ${REDACTION_MARKER} FROM t1`);
      expect(redacted).not.toContain(PROVIDER_CREDENTIAL);
    });

    it('masks a credentialed connection string passed as a literal', () => {
      const sql = `SELECT col_a FROM dblink('${CONNECTION_STRING}', 'SELECT 1') AS t1(col_a int)`;
      const redacted = redactSqlStatement(sql);

      expect(redacted).toBe('SELECT col_a FROM dblink(?, ?) AS t1(col_a int)');
      expect(redacted).not.toContain(CONNECTION_PASSWORD);
    });

    it('scrubs the userinfo of a connection string in structure position', () => {
      // The scheme and the authority stay so the statement remains
      // diagnosable; only the credential goes.
      const redacted = redactSqlStatement(
        `SELECT col_a FROM dblink_connect(${CONNECTION_STRING}) AS t1`,
      );

      expect(redacted).toContain('postgres' + 'ql://' + REDACTION_MARKER + '@');
      expect(redacted).toContain('/db_a) AS t1');
      expect(redacted).not.toContain(CONNECTION_USER);
      expect(redacted).not.toContain(CONNECTION_PASSWORD);
    });
  });
});

describe('redactSqlStatementWithFindings', () => {
  it('reports no literals and no truncation for an empty statement', () => {
    expect(redactSqlStatementWithFindings('')).toEqual({
      statement: '',
      literalCount: 0,
      truncated: false,
    });
  });

  it('returns the same statement as redactSqlStatement for every fixture', () => {
    for (const sql of FIXTURE_STATEMENTS) {
      expect(redactSqlStatementWithFindings(sql).statement).toBe(redactSqlStatement(sql));
    }
  });

  it('counts the literals of the input rather than the masks of the output', () => {
    // A dropped comment is not a literal, and the count describes what
    // arrived - which is what makes it a useful findings report.
    const findings = redactSqlStatementWithFindings(
      "SELECT col_a FROM t1 /* note */ WHERE a = 'x' AND b = 2 AND c = $1",
    );

    expect(findings.literalCount).toBe(2);
    expect(findings.truncated).toBe(false);
  });

  it('carries no part of any replaced value', () => {
    // The counts are the whole report: that is what makes a findings object
    // safe to log next to a statement that could not itself be logged.
    for (const fixture of FIXTURES) {
      const serialised = JSON.stringify(redactSqlStatementWithFindings(fixture.sql));

      for (const forbidden of fixture.forbiddenValues) {
        expect(serialised).not.toContain(forbidden);
      }
    }
  });
});

describe('normalizeSqlStatement', () => {
  describe('the grouping key', () => {
    it('unifies positional placeholders so one group holds every parameter set', () => {
      // This is the whole point of the key: `../aggregate/queries.ts` groups
      // by the exact returned string, and a statement executed a hundred
      // times with a hundred parameter sets must be one group, not a hundred.
      expect(
        normalizeSqlStatement('SELECT id, name FROM items WHERE id = $1 AND status = $2'),
      ).toBe('SELECT id, name FROM items WHERE id = ? AND status = ?');
    });

    it('groups two executions that differ only in their literal values', () => {
      const first = "INSERT INTO t1 (col_a, col_b) VALUES ('alphavalue', 1)";
      const second = "INSERT INTO t1 (col_a, col_b) VALUES ('betavalue', 2)";

      expect(normalizeSqlStatement(first)).toBe(normalizeSqlStatement(second));
      expect(normalizeSqlStatement(first)).toBe('INSERT INTO t1 (col_a, col_b) VALUES (?)');
    });

    it('groups a parameterised execution with the same statement written inline', () => {
      // The instrumented tiers emit both shapes - Prisma parameterises, a raw
      // `pool.query` may interpolate - and both describe the same query.
      const parameterised = 'SELECT col_a FROM t1 WHERE col_a = $1';
      const inlined = "SELECT col_a FROM t1 WHERE col_a = 'alphavalue'";

      expect(normalizeSqlStatement(parameterised)).toBe(normalizeSqlStatement(inlined));
    });

    it('keeps statements of different shape in different groups', () => {
      const selectA = 'SELECT col_a FROM t1 WHERE id = $1';
      const selectB = 'SELECT col_b FROM t1 WHERE id = $1';
      const selectJoined = 'SELECT col_a FROM t1 JOIN t2 ON t2.id = t1.id WHERE id = $1';

      expect(normalizeSqlStatement(selectA)).not.toBe(normalizeSqlStatement(selectB));
      expect(normalizeSqlStatement(selectA)).not.toBe(normalizeSqlStatement(selectJoined));
    });

    it('returns an empty key for an empty statement', () => {
      expect(normalizeSqlStatement('')).toBe('');
      expect(normalizeSqlStatement('   ')).toBe('');
    });
  });

  describe('whitespace and terminators', () => {
    it('collapses every whitespace run to one space and trims the result', () => {
      expect(normalizeSqlStatement('  SELECT id\n\n  FROM items\t\tWHERE id = $1  ')).toBe(
        'SELECT id FROM items WHERE id = ?',
      );
    });

    it('groups a statement reformatted across lines with its one-line form', () => {
      const reformatted = 'SELECT id\n  FROM items\tWHERE id = $1;';
      const oneLine = 'SELECT id FROM items WHERE id = $1';

      expect(normalizeSqlStatement(reformatted)).toBe(normalizeSqlStatement(oneLine));
    });

    it('strips a trailing terminator, including a run of them', () => {
      // A run rather than one character, so that the key is a fixed point: a
      // single-character strip would leave a key that normalises again to
      // something shorter, and one statement would land in two groups
      // depending on how often a caller normalised.
      expect(normalizeSqlStatement('SELECT col_a FROM t1;')).toBe('SELECT col_a FROM t1');
      expect(normalizeSqlStatement('SELECT col_a FROM t1 ;; ')).toBe('SELECT col_a FROM t1');
    });

    it('keeps a terminator that separates two statements of a batch', () => {
      // An internal `;` is structure: two statements in one span are not the
      // same query as either one alone.
      expect(normalizeSqlStatement("SELECT 1; SELECT 'secondvalue';")).toBe('SELECT ?; SELECT ?');
    });

    it('leaves whitespace inside a quoted identifier alone', () => {
      // That text is part of a name, so collapsing it would rename the
      // column - which is why collapsing happens inside the scanner, where
      // the state is known, rather than as a blanket replacement.
      expect(normalizeSqlStatement('SELECT "Two  Words" FROM t1')).toBe(
        'SELECT "Two  Words" FROM t1',
      );
    });

    it('replaces a comment with a single space in the key', () => {
      const commented = 'SELECT /* note */ col_a\n-- another note\nFROM t1';

      expect(normalizeSqlStatement(commented)).toBe('SELECT col_a FROM t1');
      expect(normalizeSqlStatement(commented)).toBe(normalizeSqlStatement('SELECT col_a FROM t1'));
    });
  });

  describe('value lists', () => {
    it('folds a masked value list so its length does not fragment groups', () => {
      const three = 'SELECT col_a FROM t1 WHERE id IN ($1, $2, $3)';
      const two = 'SELECT col_a FROM t1 WHERE id IN ($1,$2)';

      expect(normalizeSqlStatement(three)).toBe('SELECT col_a FROM t1 WHERE id IN (?)');
      expect(normalizeSqlStatement(two)).toBe(normalizeSqlStatement(three));
    });

    it('folds an inlined value list to the same key as a parameterised one', () => {
      const inlined = 'SELECT col_a FROM t1 WHERE id IN (1, 2, 3, 4)';
      const parameterised = 'SELECT col_a FROM t1 WHERE id IN ($1, $2)';

      expect(normalizeSqlStatement(inlined)).toBe(normalizeSqlStatement(parameterised));
    });

    it('leaves a single masked value in parentheses unfolded', () => {
      expect(normalizeSqlStatement("INSERT INTO t1 (col_a) VALUES ('alphavalue')")).toBe(
        'INSERT INTO t1 (col_a) VALUES (?)',
      );
    });

    it('folds each list of a multi-row insert independently', () => {
      expect(
        normalizeSqlStatement(
          "INSERT INTO orders_t (col_a, col_b) VALUES ('alphavalue', 1), ('betavalue', 2)",
        ),
      ).toBe('INSERT INTO orders_t (col_a, col_b) VALUES (?), (?)');
    });

    it('folds a long value list without fragmenting or timing out', () => {
      const values = Array.from({ length: 500 }, (_, index) => String(index)).join(', ');

      expect(normalizeSqlStatement(`SELECT col_a FROM t1 WHERE id IN (${values})`)).toBe(
        'SELECT col_a FROM t1 WHERE id IN (?)',
      );
    });
  });

  describe('case, which is deliberately not folded', () => {
    it('keeps two statements differing only in keyword case in different groups', () => {
      // Deliberate: PostgreSQL quoted identifiers are case-sensitive, so
      // lower-casing the text would merge statements that address different
      // schema. The cost is that `select` and `SELECT` are two groups; the
      // alternative is a wrong answer rather than a noisy one.
      expect(normalizeSqlStatement('select col_a from t1')).toBe('select col_a from t1');
      expect(normalizeSqlStatement('SELECT col_a FROM t1')).not.toBe(
        normalizeSqlStatement('select col_a from t1'),
      );
    });

    it('keeps quoted identifiers that differ only in case in different groups', () => {
      // `"Col"` and `"col"` are different columns in PostgreSQL, which is the
      // reason case folding is refused rather than an accident of it.
      expect(normalizeSqlStatement('SELECT "Col" FROM t1')).not.toBe(
        normalizeSqlStatement('SELECT "col" FROM t1'),
      );
    });
  });

  describe('privacy, which the key inherits', () => {
    it('masks inline literals in the key exactly as redaction does', () => {
      const sql = "SELECT col_a FROM t1 WHERE col_a = 'privatevalue' AND b = 42";

      expect(normalizeSqlStatement(sql)).toBe('SELECT col_a FROM t1 WHERE col_a = ? AND b = ?');
    });

    it('removes credential material from the key', () => {
      const key = normalizeSqlStatement(
        `SELECT col_a FROM t1 WHERE col_a = '${PROVIDER_CREDENTIAL}' -- ${CONNECTION_STRING}`,
      );

      expect(key).not.toContain(PROVIDER_CREDENTIAL);
      expect(key).not.toContain(CONNECTION_PASSWORD);
      expect(containsDenied(key)).toBe(false);
    });
  });
});

describe('bounds', () => {
  /** Structural prefix used to build statements of an exact length. */
  const BOUNDED_HEAD = 'SELECT col_a FROM t1 WHERE col_a = $1 AND ';

  /** A value planted past the scan bound; it must never be returned. */
  const PLANTED_TAIL = 'PLANTED' + '_TAIL_VALUE';

  it('returns a statement of exactly the bound unchanged', () => {
    const sql = BOUNDED_HEAD + 'x'.repeat(SQL_MAX_LENGTH - BOUNDED_HEAD.length);
    const findings = redactSqlStatementWithFindings(sql);

    expect(sql).toHaveLength(SQL_MAX_LENGTH);
    expect(findings.truncated).toBe(false);
    expect(findings.statement).toBe(sql);
  });

  it('cuts one code unit past the bound and marks the remainder', () => {
    const sql = BOUNDED_HEAD + 'x'.repeat(SQL_MAX_LENGTH - BOUNDED_HEAD.length) + 'y';
    const findings = redactSqlStatementWithFindings(sql);

    expect(findings.truncated).toBe(true);
    expect(findings.statement.endsWith(REDACTION_MARKER)).toBe(true);
    expect(findings.statement.length).toBeLessThanOrEqual(SQL_MAX_LENGTH);
  });

  it('never returns text from past the bound', () => {
    // The guarantee is not "the result is short" but "unscanned text is not
    // returned": the tail is replaced by the marker rather than passed
    // through, so a value beyond the window cannot reach the store, the
    // panel or the model.
    const sql =
      'SELECT col_a FROM t1 WHERE col_a = ' +
      'x'.repeat(SQL_MAX_LENGTH) +
      " AND col_b = '" +
      PLANTED_TAIL +
      "'";
    const findings = redactSqlStatementWithFindings(sql);

    expect(findings.truncated).toBe(true);
    expect(findings.statement).not.toContain(PLANTED_TAIL);
    expect(findings.statement.endsWith(REDACTION_MARKER)).toBe(true);
    expect(findings.statement.length).toBeLessThanOrEqual(SQL_MAX_LENGTH);
  });

  it('masks a literal the bound cuts in half', () => {
    // The cut leaves the string unterminated, and an unterminated string is
    // masked whole - so a literal that straddles the bound contributes a
    // mask, never a prefix of its value.
    const findings = redactSqlStatementWithFindings(
      'SELECT col_a FROM t1 WHERE col_a = ' + "'" + 'z'.repeat(SQL_MAX_LENGTH) + "'",
    );

    expect(findings.statement).toBe(
      'SELECT col_a FROM t1 WHERE col_a = ' + REDACTION_MASK + REDACTION_MARKER,
    );
    expect(findings.literalCount).toBe(1);
    expect(findings.truncated).toBe(true);
  });

  it('never splits a surrogate pair at the cut', () => {
    // The cut is a code-unit bound, so a pair straddling it would leave a
    // lone surrogate - which is not just mojibake: it cannot round-trip
    // through the store or the JSON the panel is served over. The pair here
    // starts exactly at the cut position.
    const cutPosition = SQL_MAX_LENGTH - REDACTION_MARKER.length;
    const sql = 'x'.repeat(cutPosition - 1) + '\u{1F600}' + " AND col_a = 'tailvalue'";
    const statement = redactSqlStatement(sql);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    expect(sql.charCodeAt(cutPosition - 1)).toBeGreaterThanOrEqual(0xd800);
    expect(statement.endsWith(REDACTION_MARKER)).toBe(true);
    expect(statement.length).toBeLessThanOrEqual(SQL_MAX_LENGTH);
    expect(loneSurrogate.test(statement)).toBe(false);
    expect(statement).not.toContain('tailvalue');
  });

  it('bounds the grouping key as well', () => {
    const key = normalizeSqlStatement(
      'SELECT col_a FROM t1 WHERE col_a = ' + 'x'.repeat(SQL_MAX_LENGTH) + ' ' + PLANTED_TAIL,
    );

    expect(key.length).toBeLessThanOrEqual(SQL_MAX_LENGTH);
    expect(key.endsWith(REDACTION_MARKER)).toBe(true);
    expect(key).not.toContain(PLANTED_TAIL);
  });
});

describe('properties over every fixture', () => {
  it('leaks no distinctive value into either output', () => {
    // The sweep is the assertion that matters most: a case-by-case expected
    // string proves the shape, while this proves the absence of the data in
    // whatever position the handler chose to put it.
    for (const fixture of FIXTURES) {
      const redacted = redactSqlStatement(fixture.sql);
      const key = normalizeSqlStatement(fixture.sql);

      for (const forbidden of fixture.forbiddenValues) {
        expect(redacted, `redacted ${fixture.name}`).not.toContain(forbidden);
        expect(key, `key for ${fixture.name}`).not.toContain(forbidden);
      }
    }
  });

  it('emits no inline string literal', () => {
    // Every `'` in the input opens a construct that leaves as a mask, so a
    // single quote in the output would mean a literal survived the scan.
    for (const sql of FIXTURE_STATEMENTS) {
      expect(redactSqlStatement(sql)).not.toContain("'");
      expect(normalizeSqlStatement(sql)).not.toContain("'");
    }
  });

  it('emits nothing the deny list recognises', () => {
    // The cross-checkpoint assertion (AAP 0.5.3): the outbound model guard
    // runs the same rules over every prompt payload and rejects the call if
    // one matches. A statement that leaves this handler must therefore be
    // clean by those rules, or the analysis stage cannot send it at all.
    for (const sql of FIXTURE_STATEMENTS) {
      expect(containsDenied(redactSqlStatement(sql))).toBe(false);
      expect(containsDenied(normalizeSqlStatement(sql))).toBe(false);
    }
  });

  it('is a fixed point after one application', () => {
    // Idempotence is load-bearing in two places: an event can be redacted at
    // ingest and again on the outbound path, and a consumer may normalise a
    // key it was handed. Neither may change the value.
    for (const sql of FIXTURE_STATEMENTS) {
      const redacted = redactSqlStatement(sql);
      const key = normalizeSqlStatement(sql);

      expect(redactSqlStatement(redacted)).toBe(redacted);
      expect(normalizeSqlStatement(key)).toBe(key);
      expect(normalizeSqlStatement(redacted)).toBe(key);
    }
  });

  it('never doubles a mask, unfolds a list or re-expands whitespace', () => {
    // The three concrete ways a non-idempotent implementation would show up.
    expect(redactSqlStatement('SELECT ' + REDACTION_MASK + ' FROM t1')).toBe(
      'SELECT ' + REDACTION_MASK + ' FROM t1',
    );
    expect(normalizeSqlStatement('SELECT col_a FROM t1 WHERE id IN (?)')).toBe(
      'SELECT col_a FROM t1 WHERE id IN (?)',
    );
    expect(normalizeSqlStatement('SELECT col_a FROM t1')).toBe('SELECT col_a FROM t1');
    expect(redactSqlStatement(REDACTION_MARKER)).toBe(REDACTION_MARKER);
  });
});

describe('linear time', () => {
  /**
   * Runs `work` {@link LINEAR_TIME_ITERATIONS} times and returns the elapsed
   * wall-clock milliseconds.
   *
   * `Date.now` rather than a high-resolution clock: the budget is measured in
   * seconds, and this keeps the suite free of any global that the Node and
   * happy-dom environments type differently.
   */
  function timeIterations(work: () => void): number {
    const started = Date.now();
    for (let iteration = 0; iteration < LINEAR_TIME_ITERATIONS; iteration += 1) {
      work();
    }
    return Date.now() - started;
  }

  it('scans thousands of literals within the budget', () => {
    const sql = 'SELECT col_a FROM t1 WHERE col_a IN (' + "'v', ".repeat(2_000) + "'v')";

    expect(sql.length).toBeLessThan(SQL_MAX_LENGTH);
    expect(normalizeSqlStatement(sql)).toBe('SELECT col_a FROM t1 WHERE col_a IN (?)');
    expect(
      timeIterations(() => {
        redactSqlStatement(sql);
        normalizeSqlStatement(sql);
      }),
    ).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 30_000);

  it('scans deeply nested comments within the budget', () => {
    // Depth is tracked with a counter rather than recursion, so nesting
    // costs a constant per delimiter and cannot overflow a stack.
    const depth = 2_000;
    const sql = 'SELECT ' + '/*'.repeat(depth) + ' x ' + '*/'.repeat(depth) + ' col_a FROM t1';

    expect(sql.length).toBeLessThan(SQL_MAX_LENGTH);
    expect(redactSqlStatement(sql)).toBe('SELECT   col_a FROM t1');
    expect(timeIterations(() => redactSqlStatement(sql))).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 30_000);

  it('scans hostile quote and dollar-tag runs within the budget', () => {
    // The shape that would make an alternating regular expression backtrack
    // catastrophically: a long run of quotes followed by a long run of
    // dollar-quote delimiters. A single-pass scanner is indifferent to it.
    const sql = "'".repeat(4_000) + '$a$'.repeat(2_000);

    expect(sql.length).toBeLessThan(SQL_MAX_LENGTH);
    expect(redactSqlStatement(sql)).not.toContain("'");
    expect(
      timeIterations(() => {
        redactSqlStatement(sql);
        normalizeSqlStatement(sql);
      }),
    ).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 30_000);

  it('scans a statement past the bound within the budget', () => {
    // Input arrives unbounded; the work stays bounded by the scan window,
    // so a statement an order of magnitude over the bound costs no more
    // than one at it.
    const sql = 'SELECT col_a FROM t1 WHERE col_a IN (' + "'v', ".repeat(40_000) + "'v')";

    expect(sql.length).toBeGreaterThan(SQL_MAX_LENGTH * 10);
    expect(redactSqlStatement(sql).endsWith(REDACTION_MARKER)).toBe(true);
    expect(
      timeIterations(() => {
        redactSqlStatement(sql);
        normalizeSqlStatement(sql);
      }),
    ).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 30_000);
});

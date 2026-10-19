/** Tiny arithmetic evaluator for the calculator drawer (no eval). Supports + - * / ( ) and decimals. */

type Token = { t: "num"; v: number } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const s = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/\s+/g, "");
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      if ((raw.match(/\./g) ?? []).length > 1) throw new Error("Bad number");
      tokens.push({ t: "num", v: Number(raw) });
      i = j;
    } else if ("+-*/()".includes(ch)) {
      tokens.push({ t: "op", v: ch });
      i++;
    } else {
      throw new Error("Bad character");
    }
  }
  return tokens;
}

/** Evaluate an expression; throws on malformed input or division by zero. */
export function evaluate(src: string): number {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const t = peek();
    return t !== undefined && t.t === "op" && t.v === v;
  };

  function parseExpr(): number {
    let left = parseTerm();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { v: string }).v;
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (isOp("*") || isOp("/")) {
      const op = (tokens[pos++] as { v: string }).v;
      const right = parseFactor();
      if (op === "/" && right === 0) throw new Error("Divide by zero");
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number {
    const t = tokens[pos++];
    if (!t) throw new Error("Unexpected end");
    if (t.t === "num") return t.v;
    if (t.v === "-") return -parseFactor();
    if (t.v === "+") return parseFactor();
    if (t.v === "(") {
      const v = parseExpr();
      if (!isOp(")")) throw new Error("Missing )");
      pos++;
      return v;
    }
    throw new Error("Unexpected " + t.v);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error("Unexpected input");
  return Math.round(result * 1e9) / 1e9;
}

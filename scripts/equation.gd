## Equation parsing, ported from the web version's compileEquation() in game.js.
## Only digits, x, + - * / ^ ( ) , . and a small function whitelist are
## allowed, then the expression is handed to Godot's Expression class (the
## engine's own safe formula evaluator — no "eval", no arbitrary code).
class_name Equation
extends RefCounted

const ALLOWED_FNS: Array[String] = ["sqrt", "sin", "cos", "tan", "abs", "log", "pow", "min", "max"]
const FN_LIST_TEXT := "sin, cos, tan, sqrt, abs, log"

## Thrown as a Dictionary {ok: false, error: String} rather than GDScript's
## own exceptions (Expression already reports failure without one, and this
## keeps the error-message plumbing identical to the JS version's `throw`).
class Compiled:
	var expr: Expression
	var text: String # the raw text this was compiled from, kept for the typeset label

	func _init(e: Expression, raw: String) -> void:
		expr = e
		text = raw

	## The curve's height at x, or NAN where it's undefined (sqrt of a
	## negative, log of 0, division by zero...). Mirrors curveAt() in game.js.
	func at(x: float) -> float:
		var result = expr.execute([x], null, false)
		if expr.has_execute_failed():
			return NAN
		if typeof(result) != TYPE_FLOAT and typeof(result) != TYPE_INT:
			return NAN
		var y: float = float(result)
		return y if is_finite(y) else NAN


## Returns {ok: true, compiled: Compiled} or {ok: false, error: String}.
static func compile(raw: String) -> Dictionary:
	var expr_src := raw.strip_edges()

	var re_y := RegEx.new()
	re_y.compile("(?i)^y\\s*=\\s*")
	expr_src = re_y.sub(expr_src, "", false)
	expr_src = expr_src.replace("²", "^2").replace("³", "^3")
	expr_src = expr_src.replace("X", "x")
	var re_pi := RegEx.new()
	re_pi.compile("(?i)π|pi")
	expr_src = re_pi.sub(expr_src, "(%s)" % [String.num(PI, 15)], true)

	if expr_src == "":
		return {"ok": false, "error": "Type an equation first, like 0.5x + 2."}

	# swap function names for #A#-style tokens so their letters (the x in
	# "max", say) can't confuse the x and implicit-multiplication rules below
	for i in ALLOWED_FNS.size():
		var fn := ALLOWED_FNS[i]
		var re_fn := RegEx.new()
		re_fn.compile("(?i)%s" % fn)
		expr_src = re_fn.sub(expr_src, "#%s#" % char(65 + i), true)

	var re_leftover := RegEx.new()
	re_leftover.compile("#[A-I]#")
	var stripped := re_leftover.sub(expr_src, "", true)
	var re_letters := RegEx.new()
	re_letters.compile("(?i)[a-z]*[a-wyz][a-z]*")
	var leftover := re_letters.search(stripped)
	if leftover:
		return {"ok": false, "error": "\"%s\" isn't allowed. Use x, numbers and %s." % [leftover.get_string(), FN_LIST_TEXT]}

	var re_bare := RegEx.new()
	re_bare.compile("#([A-I])#(?!\\s*\\()")
	var bare_fn := re_bare.search(expr_src)
	if bare_fn:
		var fn_name: String = ALLOWED_FNS[bare_fn.get_string(1).unicode_at(0) - 65]
		return {"ok": false, "error": "Put brackets after %s, like %s(x)." % [fn_name, fn_name]}

	var re_charset := RegEx.new()
	re_charset.compile("^[0-9x+\\-*/^().,\\s#A-I]+$")
	if not re_charset.search(expr_src):
		return {"ok": false, "error": "Only numbers, x, + - * / ^ and brackets are allowed."}

	var depth := 0
	for ch in expr_src:
		if ch == "(":
			depth += 1
		elif ch == ")":
			depth -= 1
		if depth < 0:
			return {"ok": false, "error": "There is an extra \")\" in the equation."}
	if depth > 0:
		return {"ok": false, "error": "A closing bracket \")\" is missing."}

	# a leading or post-operator "-" becomes "(-1)*", and a unary "+" is
	# dropped — keeps precedence identical to the web version rather than
	# relying on Expression's own unary-minus handling
	var re_minus := RegEx.new()
	re_minus.compile("(^|[+\\-*/(,])(\\s*)-")
	expr_src = re_minus.sub(expr_src, "$1$2(-1)*", true)
	var re_plus := RegEx.new()
	re_plus.compile("(^|[+\\-*/(,])(\\s*)\\+")
	expr_src = re_plus.sub(expr_src, "$1$2", true)

	expr_src = expr_src.replace("^", "**")

	# implicit multiplication: 2x, 2(, x(, )x, )(, xx, and 2sin( / xsin( / )sin(
	var re_num_x := RegEx.new()
	re_num_x.compile("(\\d)\\s*(x)")
	expr_src = re_num_x.sub(expr_src, "$1*$2", true)
	var re_xx := RegEx.new()
	re_xx.compile("x(?=\\s*x)")
	expr_src = re_xx.sub(expr_src, "x*", true)
	var re_paren_open := RegEx.new()
	re_paren_open.compile("(\\d|x)\\s*\\(")
	expr_src = re_paren_open.sub(expr_src, "$1*(", true)
	var re_paren_close := RegEx.new()
	re_paren_close.compile("\\)\\s*(x|\\d)")
	expr_src = re_paren_close.sub(expr_src, ")*$1", true)
	var re_close_open := RegEx.new()
	re_close_open.compile("\\)\\s*\\(")
	expr_src = re_close_open.sub(expr_src, ")*(", true)
	var re_hash := RegEx.new()
	re_hash.compile("(\\d|x|\\))\\s*#")
	expr_src = re_hash.sub(expr_src, "$1*#", true)

	# RegEx has no "replace with callback" in GDScript, so walk and substitute
	# #A#.."#I# one letter at a time (at most 9 — the whitelist size) instead
	var body := expr_src
	for i in ALLOWED_FNS.size():
		var token := "#%s#" % char(65 + i)
		body = body.replace(token, ALLOWED_FNS[i])

	var expr := Expression.new()
	var err := expr.parse(body, ["x"])
	if err != OK:
		return {"ok": false, "error": "That equation looks incomplete. Check for a missing number or bracket."}

	# it only needs to exist somewhere on the playfield, so sample a wide
	# range instead of a single point (sqrt(x - 5) is undefined at x = 1,
	# which is fine)
	var defined := false
	var x := -40.0
	while x <= 40.0 and not defined:
		var result = expr.execute([x], null, false)
		if expr.has_execute_failed():
			return {"ok": false, "error": "That equation looks incomplete. Check for a missing number or bracket."}
		if (typeof(result) == TYPE_FLOAT or typeof(result) == TYPE_INT) and is_finite(float(result)):
			defined = true
		x += 0.25
	if not defined:
		return {"ok": false, "error": "That equation has no points on the graph. Try another one."}

	return {"ok": true, "compiled": Compiled.new(expr, raw)}


## Slope of f at x; falls back to a one-sided difference right at the edge of
## a curve's domain, and is NAN only when the curve isn't defined on either
## side. Mirrors numericSlope() in game.js.
static func numeric_slope(c: Compiled, x: float, h: float = 0.001) -> float:
	var y0 := c.at(x)
	var yl := c.at(x - h)
	var yr := c.at(x + h)
	var central := (yr - yl) / (2.0 * h)
	if is_finite(central):
		return central
	var back := (y0 - yl) / h
	if is_finite(back):
		return back
	var fwd := (yr - y0) / h
	return fwd if is_finite(fwd) else NAN

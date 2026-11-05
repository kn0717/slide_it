## Maths typesetting, ported from mathRuns()/typesetHTML() in the web
## version's game.js. Turns what the player typed ("0.2x^2 - 4") into runs of
## properly set maths: italic x, raised exponents, a real minus sign, pi and
## implied multiplication left implicit. Used for the curve label (drawn on
## the GraphView canvas) and the live preview under the equation box (a
## RichTextLabel, via to_bbcode()).
class_name MathTypeset
extends RefCounted

## order matters: the first whitelist entry a word STARTS WITH wins, same as
## the JS version's Object.keys() insertion-order scan
const TYPESET_FNS := {
	"sqrt": "√", "sin": "sin", "cos": "cos", "tan": "tan", "abs": "abs",
	"log": "log", "pow": "pow", "min": "min", "max": "max", "pi": "π"
}

class Run:
	var t: String
	var italic: bool
	var sup: bool

	func _init(text: String, is_italic: bool = false, is_sup: bool = false) -> void:
		t = text
		italic = is_italic
		sup = is_sup


static func _is_space(ch: String) -> bool:
	return ch == " " or ch == "\t" or ch == "\n" or ch == "\r"


static func _is_letter(ch: String) -> bool:
	return (ch >= "a" and ch <= "z") or (ch >= "A" and ch <= "Z") or ch == "π"


static func runs(raw: String) -> Array[Run]:
	var s := raw.strip_edges()
	var re_y := RegEx.new()
	re_y.compile("(?i)^y\\s*=\\s*")
	s = re_y.sub(s, "", false)
	s = s.replace("**", "^").replace("²", "^2").replace("³", "^3")

	var out: Array[Run] = []
	var prev_operand := false
	var i := 0
	var n := s.length()

	while i < n:
		var ch := s[i]
		if _is_space(ch):
			i += 1
			continue

		if ch == "^":
			var j := i + 1
			var exp := ""
			if j < n and s[j] == "(":
				var depth := 0
				while j < n:
					if s[j] == "(":
						depth += 1
					if s[j] == ")":
						depth -= 1
					exp += s[j]
					j += 1
					if depth == 0:
						break
				var re_wrapped := RegEx.new()
				re_wrapped.compile("^\\([\\d.x\\-]+\\)$")
				if re_wrapped.search(exp):
					exp = exp.substr(1, exp.length() - 2)
			else:
				var re_exp := RegEx.new()
				re_exp.compile("(?i)^-?[\\d.]+|^-?x")
				var m := re_exp.search(s.substr(j))
				exp = m.get_string() if m else ""
				j += exp.length()
			exp = exp.replace("-", "−")
			# split on x/X, keeping the separator, same as JS split(/(x)/i)
			var re_split := RegEx.new()
			re_split.compile("(?i)(x)")
			var last := 0
			for m2 in re_split.search_all(exp):
				if m2.get_start() > last:
					out.append(Run.new(exp.substr(last, m2.get_start() - last), false, true))
				out.append(Run.new(m2.get_string(), true, true))
				last = m2.get_end()
			if last < exp.length():
				out.append(Run.new(exp.substr(last), false, true))
			i = j
			prev_operand = true
			continue

		if ch == "*":
			i += 1
			continue

		if ch == "-" or ch == "+":
			if prev_operand:
				out.append(Run.new(" − " if ch == "-" else " + "))
			else:
				out.append(Run.new("−" if ch == "-" else ""))
			prev_operand = false
			i += 1
			continue

		if ch == "/":
			out.append(Run.new(" / "))
			prev_operand = false
			i += 1
			continue

		if _is_letter(ch):
			var re_word := RegEx.new()
			re_word.compile("(?i)^[a-zπ]+")
			var wm := re_word.search(s.substr(i))
			var word: String = wm.get_string().to_lower()
			var fn := ""
			for key in TYPESET_FNS.keys():
				if word.begins_with(key):
					fn = key
					break
			if fn != "":
				out.append(Run.new(TYPESET_FNS[fn]))
				i += fn.length()
				prev_operand = fn == "pi"
				continue
			if ch == "π":
				out.append(Run.new("π"))
				i += 1
				prev_operand = true
				continue
			out.append(Run.new(ch, true))
			i += 1
			prev_operand = true
			continue

		out.append(Run.new(", " if ch == "," else ch))
		prev_operand = ch != "(" and ch != ","
		i += 1

	return out


## BBCode for the RichTextLabel preview / panel. Godot's RichTextLabel has no
## native superscript tag, so exponents are set smaller instead of raised —
## the one visible difference from the web version's true superscripts.
static func to_bbcode(raw: String) -> String:
	var out := "[i]y[/i] = "
	for r in runs(raw):
		var t: String = r.t.replace("[", "[lb]")
		if r.sup:
			t = "[font_size=11]%s[/font_size]" % t
		if r.italic:
			t = "[i]%s[/i]" % t
		out += t
	return out

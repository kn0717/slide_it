## The graph itself: grid, curve, cube physics, portal, trail, drag-to-pan.
## Ported from the canvas-drawing and physics sections of the web version's
## game.js. Coordinate convention matches it exactly: camX/camY is the
## camera's world-space center, PX is pixels-per-unit, and to_px()/to_world()
## convert — Node2D's y-down screen space lines up with the original canvas
## context, so no axis flip is needed anywhere in this port.
class_name GraphView
extends Node2D

signal status_changed(text: String)
signal round_changed(n: int)
signal result_ready(success: bool, reason: String)

const COLORS := {
	"thistle": Color("#cdb4db"),
	"petal": Color("#ffc8dd"),
	"pink": Color("#ffafcc"),
	"icy": Color("#bde0fe"),
	"sky": Color("#a2d2ff"),
	"ink": Color("#3b2a4a"),
	"ink_soft": Color("#6b5a7b"),
	"paper": Color("#ffeef4"),
	"grid_minor": Color(222.0 / 255, 110.0 / 255, 156.0 / 255, 0.16),
	"grid_major": Color(200.0 / 255, 80.0 / 255, 135.0 / 255, 0.3),
	"portal_ring": Color("#a2d2ff"),
}
const PORTAL_ARMS := [Color("#a2d2ff"), Color("#ffffff"), Color("#6fa9e6"), Color("#d3e9ff")]

const PX := 32.0 # pixels per world unit, constant regardless of pan
const PORTAL_RADIUS := 38.0
const CUBE_SIZE := 50.0
const PORTAL_CATCH := PORTAL_RADIUS / PX + 0.35

const GRAVITY := 9.8
const MAX_ROLL_SPEED := 16.0
const MIN_SLIDE_SPEED := 3.0
const FRICTION := 0.04
const MAX_SLIDE_SECONDS := 15.0
const MAX_RUN_SECONDS := 25.0
const START_Y := 7.0
const PORTAL_HEADROOM := 2.5
const PORTAL_AREA := Vector2(23.0, 10.0)
const TRAIL_LENGTH := 70

var cam_x := 0.0
var cam_y := 0.0

var round := 1
var equation: Equation.Compiled = null
var equation_text := ""
var running := false
var failed := false
var ever_landed := false
var on_curve := false
var ball_angle := 0.0
var ball_pos := Vector2.ZERO
var ball_v := Vector2.ZERO # vx, vy while airborne
var ball_speed := 0.0 # tangent speed while on the curve
var ball_dir := 1.0
var portal_pos := Vector2.ZERO
var absorb_start := -1
var absorb_duration := 550
var absorb_pose: Dictionary = {}
var landed_at := -1
var trail: Array[Vector2] = []
var stopped_for := 0.0
var slide_time := 0.0
var run_time := 0.0
var level: Dictionary = {}

## In viewport pixels, set by Main from the floating panel's rect. Levels and
## axis labels avoid this area, mirroring isUnderPanel()/the label-avoidance
## logic in game.js.
var panel_rect := Rect2()

var _dragging := false
var _drag_start_px := Vector2.ZERO
var _drag_start_cam := Vector2.ZERO
var _result_timer: Timer
var _pending_result := {"success": false, "reason": ""}


func _ready() -> void:
	_result_timer = Timer.new()
	_result_timer.one_shot = true
	add_child(_result_timer)
	_result_timer.timeout.connect(_on_result_timeout)
	set_process(true)
	set_process_unhandled_input(true)


func view_size() -> Vector2:
	return get_viewport_rect().size


func to_px(x: float, y: float) -> Vector2:
	var v := view_size()
	return Vector2(v.x / 2.0 + (x - cam_x) * PX, v.y / 2.0 - (y - cam_y) * PX)


func to_world(px: float, py: float) -> Vector2:
	var v := view_size()
	return Vector2(cam_x + (px - v.x / 2.0) / PX, cam_y - (py - v.y / 2.0) / PX)


func cube_half_world() -> float:
	return CUBE_SIZE / 2.0 / PX


# ---------- Curve sampling ----------

func curve_at(x: float) -> float:
	return equation.at(x) if equation else NAN


func numeric_slope(x: float) -> float:
	return Equation.numeric_slope(equation, x) if equation else NAN


# ---------- Level generation ----------

func _rand_range(a: float, b: float) -> float:
	return randf() * (b - a) + a


func _is_under_panel(x: float, y: float, margin_px: float) -> bool:
	if panel_rect.size == Vector2.ZERO:
		return false
	var p := to_px(x, y)
	var r := panel_rect.grow(margin_px)
	return r.has_point(p)


func _play_bounds() -> Dictionary:
	var margin := 1.2
	var v := view_size()
	var half_w: float = v.x / 2.0 / PX - margin
	var half_h: float = v.y / 2.0 / PX - margin
	return {
		"x_max": minf(8.0, half_w),
		"y_top": minf(START_Y, half_h),
		"y_bottom": maxf(-7.0, -half_h),
		"portal_x": minf(PORTAL_AREA.x, half_w),
		"portal_y": minf(PORTAL_AREA.y, half_h),
	}


func _pick_start(b: Dictionary) -> Vector2:
	for t in range(80):
		var x: float = _rand_range(-b.x_max, b.x_max)
		if not _is_under_panel(x, b.y_top, CUBE_SIZE):
			return Vector2(x, b.y_top)
	var x: float = _rand_range(-b.x_max, b.x_max)
	var y: float = b.y_top
	while y > b.y_bottom + PORTAL_HEADROOM + 2.0 and _is_under_panel(x, y, CUBE_SIZE):
		y -= 0.25
	return Vector2(x, y)


func new_level() -> void:
	var b := _play_bounds()
	var start := _pick_start(b)
	var best: Dictionary = {}
	for tries in range(300):
		var portal_x: float = _rand_range(-b.portal_x, b.portal_x)
		var portal_y: float = _rand_range(-b.portal_y, b.portal_y)
		if absf(portal_x - start.x) < 3.0:
			continue
		best = {"start": start, "portal": Vector2(portal_x, portal_y)}
		if not _is_under_panel(portal_x, portal_y, PORTAL_RADIUS * 1.5):
			break
	if best.is_empty():
		var portal_x: float = -b.portal_x if start.x > 0 else b.portal_x
		best = {"start": start, "portal": Vector2(portal_x, start.y - PORTAL_HEADROOM - 1.0)}
	level = best


func begin_level(message: String, keep_equation: bool = false) -> void:
	_result_timer.stop()
	running = false
	on_curve = false
	absorb_start = -1
	ball_angle = 0.0
	failed = false
	if not keep_equation:
		equation = null
		equation_text = ""
	cam_x = 0.0
	cam_y = 0.0
	trail.clear()
	landed_at = -1
	stopped_for = 0.0
	slide_time = 0.0
	run_time = 0.0
	ever_landed = false

	ball_pos = level.start
	ball_v = Vector2.ZERO
	ball_speed = 0.0
	portal_pos = level.portal

	status_changed.emit(message)
	round_changed.emit(round)
	queue_redraw()


func setup_round() -> void:
	new_level()
	begin_level("Enter an equation and press Start")


func retry_level(eq_raw: String) -> void:
	begin_level("Same level. Adjust your equation and press Start", true)
	var r := Equation.compile(eq_raw)
	if r.ok:
		equation = r.compiled
		equation_text = eq_raw
	else:
		equation = null


func start_run(eq_raw: String) -> Dictionary:
	var r := Equation.compile(eq_raw)
	if not r.ok:
		return {"ok": false, "error": r.error}
	equation = r.compiled
	equation_text = eq_raw
	trail.clear()
	landed_at = -1
	ever_landed = false
	on_curve = false
	ball_v.y = 0.0
	running = true
	status_changed.emit("Cube is falling...")
	return {"ok": true}


func reset_run(eq_raw: String) -> void:
	if absorb_start >= 0:
		return # already going into the portal
	retry_level(eq_raw)


# ---------- Physics ----------

func _is_off_screen() -> bool:
	var v := view_size()
	var px := v.x / 2.0 + ball_pos.x * PX
	var py := v.y / 2.0 - ball_pos.y * PX
	var margin := 160.0
	return px < -margin or px > v.x + margin or py < -margin or py > v.y + margin


func _get_cube_pose() -> Dictionary:
	if on_curve and equation:
		var raw := numeric_slope(ball_pos.x)
		var slope := raw if is_finite(raw) else tan(ball_angle)
		var norm := sqrt(1.0 + slope * slope)
		var half := cube_half_world()
		return {"x": ball_pos.x + (-slope / norm) * half, "y": ball_pos.y + (1.0 / norm) * half, "angle": atan(slope)}
	return {"x": ball_pos.x, "y": ball_pos.y + cube_half_world(), "angle": ball_angle}


func _step_physics(dt: float) -> void:
	if not on_curve:
		var prev_x := ball_pos.x
		var prev_y := ball_pos.y
		ball_v.y -= GRAVITY * dt
		ball_pos.x += ball_v.x * dt
		ball_pos.y += ball_v.y * dt

		var before := curve_at(prev_x)
		var curve_y := curve_at(ball_pos.x)
		var was_above: bool = prev_y >= before if is_finite(before) else prev_y >= curve_y
		if is_finite(curve_y) and ball_pos.y <= curve_y and was_above:
			var slope := numeric_slope(ball_pos.x)
			var angle := atan(slope) if is_finite(slope) else 0.0
			ball_dir = signf(portal_pos.x - ball_pos.x)
			if ball_dir == 0.0:
				ball_dir = 1.0
			var along := (ball_v.x * cos(angle) + ball_v.y * sin(angle)) * ball_dir
			ball_speed = ball_dir * clampf(along, MIN_SLIDE_SPEED, MAX_ROLL_SPEED)
			ball_pos.y = curve_y
			ball_v.y = 0.0
			on_curve = true
			ever_landed = true
			landed_at = Time.get_ticks_msec()
			status_changed.emit("Sliding to the portal...")
	else:
		var slope := numeric_slope(ball_pos.x)
		if not is_finite(slope):
			on_curve = false
			ball_v = Vector2(ball_speed * cos(ball_angle), ball_speed * sin(ball_angle))
			return
		var angle := atan(slope)
		ball_angle = angle
		var dir := ball_dir
		var speed := ball_speed * dir
		speed += -GRAVITY * sin(angle) * dir * dt
		speed -= FRICTION * GRAVITY * cos(angle) * dt
		speed = clampf(speed, MIN_SLIDE_SPEED, MAX_ROLL_SPEED)
		ball_speed = speed * dir
		ball_v.x = ball_speed * cos(angle)
		ball_pos.x += ball_v.x * dt

		var curve_y := curve_at(ball_pos.x)
		if is_finite(curve_y):
			ball_pos.y = curve_y
		else:
			on_curve = false
			ball_v.y = ball_speed * sin(angle)


func _record_trail() -> void:
	if not on_curve:
		return
	if trail.size() > 0 and trail[-1].distance_to(ball_pos) < 0.08:
		return
	trail.append(ball_pos)
	if trail.size() > TRAIL_LENGTH:
		trail.remove_at(0)


func _check_portal() -> void:
	var pose := _get_cube_pose()
	if Vector2(pose.x, pose.y).distance_to(portal_pos) >= PORTAL_CATCH:
		return
	running = false
	status_changed.emit("Portal reached!")
	absorb_start = Time.get_ticks_msec()
	absorb_pose = pose
	_pending_result = {"success": true, "reason": ""}
	_result_timer.start((absorb_duration + 250) / 1000.0)


func _fail_level(reason: String) -> void:
	running = false
	failed = true
	stopped_for = 0.0
	status_changed.emit(reason)
	_pending_result = {"success": false, "reason": reason}
	_result_timer.start(0.7)


func _on_result_timeout() -> void:
	result_ready.emit(_pending_result.success, _pending_result.reason)


func _process(delta: float) -> void:
	_update(minf(delta, 0.033))
	queue_redraw()


func _update(dt: float) -> void:
	if not running or not equation:
		return

	var substeps := 6
	var sub_dt := dt / substeps
	for i in range(substeps):
		if not running:
			break
		_step_physics(sub_dt)
		_record_trail()
		_check_portal()

		if running and not (is_finite(ball_pos.x) and is_finite(ball_pos.y)):
			_fail_level("The cube flew off the curve.")
			break
		if running and _is_off_screen():
			_fail_level("The cube fell off the screen." if ever_landed else "The cube fell straight down. Your line wasn't under it.")
			break

	if running and on_curve and absf(ball_speed) < 0.02:
		stopped_for += dt
		if stopped_for > 1.5:
			_fail_level("The cube got stuck on the line.")
	else:
		stopped_for = 0.0

	if running:
		run_time += dt
		if on_curve:
			slide_time += dt
		if slide_time > MAX_SLIDE_SECONDS or run_time > MAX_RUN_SECONDS:
			_fail_level("The cube ran out of steam.")


# ---------- Drag to pan ----------

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_dragging = true
				_drag_start_px = mb.position
				_drag_start_cam = Vector2(cam_x, cam_y)
			else:
				_dragging = false
	elif event is InputEventMouseMotion and _dragging:
		var mm := event as InputEventMouseMotion
		var d: Vector2 = mm.position - _drag_start_px
		cam_x = _drag_start_cam.x - d.x / PX
		cam_y = _drag_start_cam.y + d.y / PX
	elif event is InputEventScreenTouch:
		var st := event as InputEventScreenTouch
		if st.pressed:
			_dragging = true
			_drag_start_px = st.position
			_drag_start_cam = Vector2(cam_x, cam_y)
		else:
			_dragging = false
	elif event is InputEventScreenDrag and _dragging:
		var sd := event as InputEventScreenDrag
		var d: Vector2 = sd.position - _drag_start_px
		cam_x = _drag_start_cam.x - d.x / PX
		cam_y = _drag_start_cam.y + d.y / PX

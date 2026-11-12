"""Browser walkthrough: student, teacher, admin. Needs `npx tsx tests/e2e/seed.ts` and the app on :3100.
    python3 tests/e2e/walkthrough.py        (screenshots in /tmp/shots)"""
import os, re, sys, datetime
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright, expect

B = "http://localhost:3100"
os.makedirs("/tmp/shots", exist_ok=True)
errors = []
today = datetime.datetime.now(ZoneInfo("America/New_York")).date()
mon = today - datetime.timedelta(days=today.weekday()) - datetime.timedelta(days=7)
D = lambda i: mon + datetime.timedelta(days=i)
short = lambda d: d.strftime("%a %m/%d")
prev_month = (today.replace(day=1) - datetime.timedelta(days=1)).strftime("%Y-%m")
long = lambda d: d.strftime("%A, %m/%d/%Y")
with open("/tmp/note.pdf", "wb") as f: f.write(b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")

def step(n): print("✓", n); sys.stdout.flush()
def draw(page, pts=None):
    box = page.locator(".inkmodal canvas").bounding_box()
    pts = pts or [(0.2, 0.6), (0.35, 0.3), (0.5, 0.65), (0.65, 0.3), (0.8, 0.6)]
    page.mouse.move(box["x"] + box["width"] * pts[0][0], box["y"] + box["height"] * pts[0][1]); page.mouse.down()
    for x, y in pts[1:]: page.mouse.move(box["x"] + box["width"] * x, box["y"] + box["height"] * y, steps=8)
    page.mouse.up()
def write_in(page, card, bubble_text, done="Done"):
    card.get_by_text(bubble_text).click(); draw(page); page.locator(".inkmodal").get_by_role("button", name=done, exact=True).click()
def student_login(page, name, pin):
    page.goto(B + "/student")
    page.fill("#who", name.split()[0]); page.click(f"text={name}")
    for d in pin: page.click(f"button:text-is('{d}')")
    page.click("text=OK"); page.wait_for_url("**/student/sheet")
def write_time(page, card, label):
    card.locator(".timecell", has_text=label).locator(".inkbubble").click(); draw(page)
    page.locator(".inkmodal").get_by_role("button", name="Done", exact=True).click()
def fill_day(page, d, note=None, lunch=True):
    card = page.locator("li.day", has_text=short(d))
    card.get_by_role("button", name="Fill in & sign").click()
    submit = card.get_by_role("button", name="Submit attendance"); expect(submit).to_be_enabled()
    write_time(page, card, "Start time")
    if lunch: write_time(page, card, "Lunch start"); write_time(page, card, "Lunch end")
    write_time(page, card, "End time")
    write_in(page, card, "Tap to sign", "Use this signature")
    if note: card.locator("textarea[name=note]").fill(note)
    submit.click()
    expect(page.locator(".confirm")).to_contain_text("Attendance submitted")
    expect(page.locator("li.day", has_text=short(d)).locator(".chip")).to_have_text("Pending")
def staff_login(page, who, email):
    page.goto(f"{B}/{who}/login"); page.fill("input[name=email]", email); page.fill("input[name=password]", "password-123456")
    page.click("button:text('Sign in')"); page.wait_for_url(f"**/{who}")
def row(page, d, name):
    return page.locator("tbody", has=page.locator("tr.dayhead", has_text=long(d))).locator("tr.rrow", has_text=name)

with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 1280, "height": 860}, has_touch=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    # ---- Home: link buttons
    page.goto(B + "/"); page.screenshot(path="/tmp/shots/01-home.png", full_page=True)
    page.click("text=Student? Find your name here"); page.wait_for_url("**/student"); step("home page link buttons")

    # ---- Student: fill in last week's days
    student_login(page, "Jennifer Quezada", "2468"); step("student signs in with name + PIN")
    page.screenshot(path="/tmp/shots/02-student-week.png", full_page=True)
    # The bug report: the button must never be stuck greyed out. Missing items are named instead.
    card = page.locator("li.day", has_text=short(D(0))); card.get_by_role("button", name="Fill in & sign").click()
    write_time(page, card, "Start time"); write_time(page, card, "Lunch start")
    card.get_by_role("button", name="Submit attendance").click()
    expect(card.locator(".msg.err")).to_contain_text("write your lunch end time, write your end time, sign"); step("submit is never disabled; it says what is missing")
    card.get_by_role("button", name="Cancel").click()
    fill_day(page, D(0), note="Forgot to sign on the day"); step("last Monday: start, lunch start, lunch end, end + signature, all by hand -> Pending")
    page.screenshot(path="/tmp/shots/03-student-confirmation.png", full_page=False)
    fill_day(page, D(1), lunch=False); step("last Tuesday submitted (no lunch break)")
    # Excuse for Wednesday
    card = page.locator("li.day", has_text=short(D(2)))
    card.get_by_role("button", name="Upload excuse").click()
    card.locator("input[type=file]").set_input_files("/tmp/note.pdf"); card.locator("textarea[name=note]").fill("I was sick")
    card.get_by_role("button", name="Upload excuse").click()
    expect(page.locator(".confirm")).to_contain_text("Excuse uploaded")
    expect(page.locator("li.day", has_text=short(D(2)))).to_contain_text("waiting for your teacher"); step("excuse uploaded, day stays Absent")
    page.click("text=Done, sign out"); page.wait_for_url("**/student")
    student_login(page, "Alexandra Mendez", "3579"); fill_day(page, D(0)); fill_day(page, D(3)); page.click("text=Done, sign out"); page.wait_for_url("**/student"); step("second student submitted")

    # ---- Teacher: roster
    staff_login(page, "teacher", "saniya@bhi.test"); step("teacher signs in")
    expect(page.locator("#take-h")).to_contain_text("Take attendance"); step("teacher lands on today's Take attendance")
    # Take attendance for last Thursday: tap Maria absent, sign once.
    page.goto(B + f"/teacher?view=day&date={D(3).isoformat()}")
    take = page.locator("section.take")
    take.locator(".take-btn", has_text="Maria Lopez").click()
    expect(take.locator(".take-btn", has_text="Maria Lopez")).to_have_attribute("aria-pressed", "true")
    expect(take.locator(".take-sum")).to_contain_text("1 to approve · 1 absent · 1 present but not signed yet")
    page.screenshot(path="/tmp/shots/14-take-attendance.png", full_page=True)
    take.get_by_role("button", name=re.compile("Sign once and save")).click(); draw(page)
    page.locator(".inkmodal").get_by_role("button", name="Sign and save").click()
    expect(take.locator(".msg.ok")).to_contain_text("1 approved and signed, 1 absent")
    expect(take.locator(".msg.ok")).to_contain_text("hasn't signed yet: Jennifer Quezada")
    expect(page.locator(".take-btn", has_text="Alexandra Mendez")).to_contain_text("approved")
    step("take attendance: tap the absent, sign once, the rest approved")
    page.goto(B + "/teacher?view=week")
    page.get_by_label("Previous week").click(); page.wait_for_url("**date=*")
    expect(page.locator("h1")).to_have_text("My attendance roster")
    page.screenshot(path="/tmp/shots/04-teacher-roster.png", full_page=True)
    expect(page.locator(".filter", has_text="Pending")).to_contain_text("3")
    # Approve one with a handwritten signature
    row(page, D(0), "Jennifer Quezada").get_by_role("button", name="Check & sign").click()
    draw(page); page.locator(".inkmodal").get_by_role("button", name="Approve and sign").click()
    expect(page.locator(".msg.ok")).to_contain_text("Approved and signed 1 day"); step("teacher approves one day by signing by hand")
    # Send one back
    r = row(page, D(1), "Jennifer Quezada"); r.get_by_role("button", name="Send back").click()
    page.fill("input[id^=why-]", "End time should be 2:00 pm"); page.locator("tr.rowpanel").get_by_role("button", name="Send back").click()
    expect(page.locator(".msg.ok")).to_contain_text("Sent back"); step("teacher sends a day back with a reason")
    # Bulk approve: tick Alexandra Monday
    row(page, D(0), "Alexandra Mendez").locator("input[type=checkbox]").check()
    page.get_by_role("button", name="Approve & sign (1)").click(); draw(page); page.locator(".inkmodal").get_by_role("button", name="Approve and sign").click()
    expect(page.locator(".msg.ok")).to_contain_text("Approved and signed 1 day"); step("bulk approve with one signature")
    # Mark Maria absent, Maria present on Tuesday (signature stays missing)
    row(page, D(0), "Maria Lopez").get_by_role("button", name="Absent").click(); expect(page.locator(".msg.ok")).to_contain_text("Marked absent")
    row(page, D(1), "Maria Lopez").get_by_role("button", name="Present").click(); expect(page.locator(".msg.ok")).to_contain_text("Marked present")
    page.get_by_role("button", name="Everyone").click()
    expect(row(page, D(1), "Maria Lopez").locator(".chip")).to_have_text("Present · signature missing"); step("marking present is not approving")
    # Excuse review
    page.get_by_role("button", name="Excuses to review").click()
    row(page, D(2), "Jennifer Quezada").get_by_role("button", name="Review excuse").click()
    href = page.locator("tr.rowpanel a", has_text="Open").get_attribute("href")
    res = page.request.get(B + href); assert res.status == 200 and res.headers["content-type"] == "application/pdf", res.status
    assert ctx.browser.new_context().request.get(B + href).status == 404, "excuse documents are private"
    page.get_by_role("button", name="Approve excuse").click(); expect(page.locator(".msg.ok")).to_contain_text("Excused"); step("teacher opens and approves the excuse")
    page.get_by_role("button", name="Everyone").click()
    page.screenshot(path="/tmp/shots/05-teacher-roster-after.png", full_page=True)
    page.get_by_role("link", name="Day").click(); page.wait_for_url("**view=day**"); page.wait_for_load_state("networkidle"); page.screenshot(path="/tmp/shots/06-teacher-day.png", full_page=True); step("day view")
    page.click("button:text('Sign out')"); page.wait_for_url("**/teacher/login")

    # ---- Student sees the results
    student_login(page, "Jennifer Quezada", "2468")
    expect(page.locator("li.day", has_text=short(D(0))).locator(".chip")).to_have_text("Approved")
    expect(page.locator("li.day", has_text=short(D(1)))).to_contain_text("End time should be 2:00 pm")
    expect(page.locator("li.day", has_text=short(D(2))).locator(".chip")).to_have_text("Excused"); step("student sees Approved, Needs correction, Excused")
    page.screenshot(path="/tmp/shots/07-student-after.png", full_page=True)
    page.click("text=Done, sign out"); page.wait_for_url("**/student")

    # ---- Admin
    staff_login(page, "admin", "admin@bhi.test"); step("admin signs in")
    page.goto(B + "/admin/students"); page.screenshot(path="/tmp/shots/08-admin-students.png", full_page=True)
    tr = page.locator("tr", has_text="Jennifer Quezada"); tr.locator("select").select_option(label="Omar Haddad"); tr.get_by_role("button", name="Save").click()
    expect(tr.locator(".msg.ok")).to_contain_text("Omar Haddad's roster"); step("admin reassigns Jennifer to Omar")
    page.locator("tr", has_text="Kevin Reid").locator("input[type=checkbox]").check()
    page.locator("#bulk select").select_option(label="Dr. Saniya"); page.click("text=Assign ticked students")
    expect(page.locator("#bulk .msg.ok")).to_contain_text("1 student moved"); step("bulk assignment")
    page.click("text=Jennifer Quezada"); page.wait_for_url("**/admin/students/*")
    page.locator("summary", has_text="Assignment history").click()
    expect(page.locator("details", has_text="Assignment history")).to_contain_text("Omar Haddad")
    old = mon - datetime.timedelta(days=3)
    page.fill("#pick-day", old.isoformat()); page.click("text=Open day")
    page.fill("#ed-start", "09:00"); page.fill("#ed-end", "12:00"); page.fill("#ed-reason", "Signed paper sheet, confirmed")
    page.locator(".editpanel").get_by_role("button", name=re.compile(r"^Save (day|correction)$")).click()
    expect(page.locator(".editpanel .msg.ok")).to_contain_text("saved"); step("admin corrects an old day")
    page.screenshot(path="/tmp/shots/09-admin-profile.png", full_page=True)
    # Mahek signs the "Approved by" at the bottom of the month, for everyone who is ready, by hand.
    page.goto(B + "/admin/sign-off")  # opens on last month
    expect(page.locator("tr", has_text="Jennifer Quezada").locator("input[type=checkbox]")).to_be_disabled()  # a day still waits for her teacher
    page.get_by_role("button", name=re.compile(r"Tick all ready")).click()
    expect(page.locator("#so-name-" + prev_month)).to_have_text("Approved by: Mahek / Asst. Director")
    expect(page.locator("tr", has_text="Maria Lopez")).to_contain_text("Needs your signature"); step("Maria's old sign-off by Pratip is flagged for Mahek")
    page.screenshot(path="/tmp/shots/10a-signoff.png", full_page=True)
    page.get_by_role("button", name=re.compile(r"^Sign off .* for \d+ student")).click(); draw(page)
    page.locator(".inkmodal").get_by_role("button", name="Sign off", exact=True).click()
    expect(page.locator(".signoff .msg.ok")).to_contain_text("Signed off"); step("Mahek signs off the month by hand")
    expect(page.locator("tr", has_text="Maria Lopez")).to_contain_text("Signed")
    expect(page.locator("tr", has_text="Maria Lopez")).to_contain_text("Mahek")
    # The printed sheet now says Mahek, with her signature, in "Approved by".
    mid = page.locator("tr", has_text="Maria Lopez").locator("a").first.get_attribute("href").split("/")[-1].split("?")[0]
    pdf = page.request.get(f"{B}/api/report/{mid}?month={prev_month}&format=pdf").body()
    open("/tmp/maria.pdf", "wb").write(pdf); step("Maria's sheet re-signed by Mahek")
    # The roster never offers admins the teacher's signature.
    page.goto(B + "/admin"); page.get_by_label("Previous week").click()
    expect(page.get_by_role("button", name="Check & sign")).to_have_count(0)
    expect(page.get_by_role("button", name=re.compile("Approve & sign"))).to_have_count(0); step("admins can't sign the teacher column")
    page.screenshot(path="/tmp/shots/10-admin-roster.png", full_page=True); step("admin roster")

    # ---- Another admin (Pratip) can see the sign-off page but can't sign "Approved by"
    page.click("button:text('Sign out')"); page.wait_for_url("**/admin/login")
    staff_login(page, "admin", "pratip@bhi.test"); page.goto(B + "/admin/sign-off")
    expect(page.locator(".msg.warnmsg")).to_contain_text("Only Mahek signs")
    expect(page.get_by_role("button", name=re.compile("^Sign off"))).to_have_count(0); step("only Mahek can sign off")

    # ---- Phone size
    m = br.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True).new_page()
    m.goto(B + "/"); m.screenshot(path="/tmp/shots/11-phone-home.png", full_page=True)
    student_login(m, "Alexandra Mendez", "3579")
    m.goto(B + f"/student/sheet?month={prev_month}")
    expect(m.locator(".approvedby")).to_contain_text("Mahek"); step("student sees Mahek's sign-off at the bottom")
    m.screenshot(path="/tmp/shots/12-phone-student.png", full_page=True)
    m.goto(B + "/student/sheet"); m.get_by_role("button", name="Fill in & sign").first.click()
    m.screenshot(path="/tmp/shots/13-phone-form.png", full_page=True); step("phone layout")
    br.close()

real = [e for e in errors if "favicon" not in e]
print("console errors:", real or "none")
sys.exit(1 if real else 0)

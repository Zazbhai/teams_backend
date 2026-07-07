# -*- coding: utf-8 -*-
import time
import argparse
import sys
import os
import tempfile
import uuid
import shutil
from datetime import datetime

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys

# -- Args -----------------------------------------------------------------------
parser = argparse.ArgumentParser(description="Teams AutoPilot - Auto Joiner")
parser.add_argument("--url",      type=str, required=True,  help="Teams meeting URL")
parser.add_argument("--name",     type=str, default="AutoPilot User", help="Display name in Teams")
parser.add_argument("--duration", type=int, required=True,  help="Minutes to stay in meeting")
parser.add_argument("--headless", action="store_true",      help="Run Chrome headless")
args = parser.parse_args()

LOG_PREFIX = "[" + args.name + "]"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCREENSHOTS_DIR = os.path.join(SCRIPT_DIR, "screenshots")
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(ts + " " + LOG_PREFIX + " " + msg, flush=True)

def screenshot(driver, name="screenshot"):
    try:
        ts = str(int(time.time()))
        path = os.path.join(SCREENSHOTS_DIR, name + "_" + ts + ".png")
        driver.save_screenshot(path)
        log("Screenshot saved: " + path)
    except Exception as e:
        log("Screenshot failed: " + str(e))

def try_click(driver, selectors, timeout=15, label="element"):
    """Try multiple (By, selector) pairs, click first that works."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for by, sel in selectors:
            try:
                el = WebDriverWait(driver, 2).until(EC.element_to_be_clickable((by, sel)))
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
                try:
                    el.click()
                except Exception:
                    driver.execute_script("arguments[0].click();", el)
                log("Clicked " + label + " via '" + sel + "'")
                return True
            except Exception:
                continue
    log("WARNING: Could not click " + label)
    return False

def try_find(driver, selectors, timeout=20, label="element"):
    """Try multiple (By, selector) pairs, return element or None."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for by, sel in selectors:
            try:
                el = WebDriverWait(driver, 2).until(EC.visibility_of_element_located((by, sel)))
                log("Found " + label + " via '" + sel + "'")
                return el
            except Exception:
                continue
    log("WARNING: Could not find " + label)
    return None

# -- Chrome Setup ---------------------------------------------------------------
log("Configuring Chrome...")
opt = Options()
opt.add_argument("--disable-infobars")
opt.add_argument("--start-maximized")
opt.add_argument("--disable-extensions")
opt.add_argument("--no-sandbox")
opt.add_argument("--disable-dev-shm-usage")
opt.add_argument("--disable-blink-features=AutomationControlled")
opt.add_argument("--disable-popup-blocking")
opt.add_argument("--use-fake-ui-for-media-stream")
opt.add_argument("--use-fake-device-for-media-stream")
opt.add_argument("--allow-running-insecure-content")
opt.add_experimental_option("excludeSwitches", ["enable-automation"])
opt.add_experimental_option("useAutomationExtension", False)
opt.add_experimental_option("prefs", {
    "profile.default_content_setting_values.media_stream_mic":    1,
    "profile.default_content_setting_values.media_stream_camera": 1,
    "profile.default_content_setting_values.geolocation":         1,
    "profile.default_content_setting_values.notifications":       1,
})

# Each Chrome instance gets its own unique user data dir to avoid
# profile lock conflicts when multiple automations run in parallel
_profile_dir = os.path.join(tempfile.gettempdir(), f"chrome_autopilot_{uuid.uuid4().hex}")
opt.add_argument(f"--user-data-dir={_profile_dir}")

if args.headless:
    opt.add_argument("--headless=new")
    opt.add_argument("--window-size=1920,1080")

driver = webdriver.Chrome(options=opt)
driver.set_page_load_timeout(120)

try:
    # 1. Open URL
    log("Opening: " + args.url)
    driver.get(args.url)

    time.sleep(2)
    try:
        ActionChains(driver).send_keys(Keys.ESCAPE).perform()
    except Exception:
        pass
    time.sleep(1)

    # 2. Continue on this browser
    log("Looking for 'Continue on this browser' button...")
    clicked = try_click(driver, [
        (By.CSS_SELECTOR, 'button[data-tid="joinOnWeb"]'),
        (By.XPATH,        '//button[contains(text(),"Continue on this browser")]'),
        (By.XPATH,        '//button[contains(text(),"Join on the web instead")]'),
        (By.XPATH,        '//a[contains(text(),"Continue on this browser")]'),
        (By.XPATH,        '//span[contains(text(),"Continue on this browser")]'),
    ], timeout=30, label="joinOnWeb")

    if not clicked:
        screenshot(driver, "no_join_web_btn")

    time.sleep(2)

    # 3. Name input
    log("Looking for name input...")
    name_el = try_find(driver, [
        (By.CSS_SELECTOR, 'input[data-tid="prejoin-display-name-input"]'),
        (By.CSS_SELECTOR, 'input[placeholder*="name" i]'),
        (By.CSS_SELECTOR, 'input[aria-label*="name" i]'),
        (By.XPATH,        '//input[@type="text"]'),
    ], timeout=30, label="name input")

    if name_el:
        name_el.clear()
        name_el.send_keys(args.name)
        log("Entered name: " + args.name)
    else:
        screenshot(driver, "no_name_input")

    time.sleep(1)

    # 4. Turn camera off
    log("Turning off camera...")
    try:
        # Wait for the hidden checkbox input to be present in the DOM
        video_toggle = WebDriverWait(driver, 5).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'input[data-tid="toggle-video"]'))
        )
        # If the checkbox is checked, the camera is on. Turn it off using JS.
        if video_toggle.is_selected() or str(video_toggle.get_attribute("checked")).lower() == "true":
            log("Camera is ON, clicking hidden checkbox to turn off...")
            driver.execute_script("arguments[0].click();", video_toggle)
        else:
            log("Camera is already OFF.")
    except Exception:
        log("Could not find specific camera checkbox, trying fallback...")
        try_click(driver, [
            (By.CSS_SELECTOR, 'div[role="switch"][aria-label*="camera" i]'),
            (By.CSS_SELECTOR, '[data-tid="toggle-video"]'),
            (By.CSS_SELECTOR, 'input[data-tid="toggle-video"]'),
            (By.XPATH,        '//button[contains(@aria-label,"Turn camera off")]'),
            (By.XPATH,        '//div[contains(@aria-label,"camera")]'),
        ], timeout=5, label="camera toggle fallback")

    time.sleep(1)

    # 5. No audio
    log("Selecting no audio...")
    try_click(driver, [
        (By.XPATH, "//span[text()=\"Don't use audio\"]"),
        (By.XPATH, "//span[contains(text(),\"Don't use audio\")]"),
        (By.XPATH, '//button[contains(@aria-label,"audio")]'),
        (By.XPATH, '//label[contains(text(),"No audio")]'),
    ], timeout=8, label="no audio")

    time.sleep(2)

    # 6. Join Now
    log("Clicking Join Now...")
    clicked = try_click(driver, [
        (By.CSS_SELECTOR, 'button[data-tid="prejoin-join-button"]'),
        (By.XPATH,        '//button[contains(text(),"Join now")]'),
        (By.XPATH,        '//button[contains(text(),"Join")]'),
        (By.XPATH,        '//span[text()="Join now"]/ancestor::button'),
    ], timeout=30, label="Join Now")

    if not clicked:
        screenshot(driver, "no_join_btn")
        log("ERROR: Could not click Join Now")
        sys.exit(1)

    # 7. Wait for connected — poll every 5 seconds for hangup button or participant badge
    log("Polling every 5s for hangup button / participant badge (confirms join accepted)...")
    connected = False
    deadline = time.time() + 120

    while time.time() < deadline:
        detected = False

        # Check for hangup button (strongest signal: we are IN the meeting)
        try:
            hangup = driver.find_element(
                By.CSS_SELECTOR,
                '#hangup-button, [data-tid="hangup-button"], button[data-tid="call-hangup"], button[aria-label="Leave"]'
            )
            if hangup.is_displayed():
                log("CONFIRMED: Hangup button visible — successfully joined meeting!")
                detected = True
        except Exception:
            pass

        # Also check for participant badge (secondary signal)
        if not detected:
            try:
                badge = driver.find_element(By.CSS_SELECTOR, '[data-tid="toolbar-item-badge"]')
                if badge:
                    log("CONFIRMED: Participant badge visible — Participants: " + badge.get_attribute("textContent").strip())
                    detected = True
            except Exception:
                pass

        # Page source fallback
        if not detected:
            src = driver.page_source
            if "hangup-button" in src or "call-hangup" in src or "toolbar-item-badge" in src:
                log("CONFIRMED: Join detected via page source.")
                detected = True

        if detected:
            connected = True
            # Auto-screenshot to confirm join
            ts = str(int(time.time()))
            auto_ss_path = os.path.join(SCREENSHOTS_DIR, "joined_" + ts + ".png")
            try:
                driver.save_screenshot(auto_ss_path)
                log("Auto-screenshot saved on join: " + auto_ss_path)
            except Exception as e:
                log("Auto-screenshot failed: " + str(e))
            break

        # Check for lobby
        try:
            el = driver.find_element(By.XPATH, "//*[contains(text(),'let you in')]")
            if el.is_displayed():
                log("Still in lobby — waiting for host to accept...")
        except Exception:
            pass

        time.sleep(5)  # Poll every 5 seconds

    if not connected:
        screenshot(driver, "stuck_state")
        log("WARNING: Could not confirm join after 120s — staying for duration anyway.")

    # 8. Stay for duration or until LEAVE command
    log("Staying for " + str(args.duration) + " minutes...")
    end_time = time.time() + (args.duration * 60)
    cmd_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cmd_" + str(os.getpid()) + ".txt")

    while time.time() < end_time:
        if os.path.exists(cmd_file):
            try:
                with open(cmd_file, "r") as f:
                    cmd = f.read().strip()
                os.remove(cmd_file)
                
                parts = cmd.split()
                if len(parts) > 0:
                    if parts[0] == "LEAVE":
                        log("Received LEAVE command from backend.")
                        break
                    elif parts[0] == "SCREENSHOT" and len(parts) > 1:
                        screenshot_path = parts[1]
                        log("Received SCREENSHOT command. Saving to " + screenshot_path)
                        driver.save_screenshot(screenshot_path)
            except Exception as e:
                log("Error reading command file: " + str(e))
        time.sleep(1)

    # 9. Leave
    log("Leaving meeting...")
    try:
        leave_btn = WebDriverWait(driver, 5).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '#hangup-button, [data-tid="hangup-button"], button[aria-label="Leave"], button[data-tid="call-hangup"]'))
        )
        log("Found leave button, forcing click via JS...")
        driver.execute_script("arguments[0].click();", leave_btn)
        time.sleep(2)
    except Exception:
        log("Could not find specific leave button, trying fallback...")
        left = try_click(driver, [
            (By.ID,           "hangup-button"),
            (By.CSS_SELECTOR, 'button[data-tid="hangup-button"]'),
            (By.CSS_SELECTOR, '[data-tid="hangup-button"]'),
            (By.XPATH,        '//button[@aria-label="Leave"]'),
            (By.XPATH,        '//button[contains(@aria-label,"leave")]'),
            (By.XPATH,        '//button[contains(@aria-label,"Leave")]'),
            (By.XPATH,        '//button[contains(text(),"Leave")]'),
            (By.XPATH,        '//div[contains(@aria-label,"Leave")]'),
            (By.XPATH,        '//div[contains(@aria-label,"leave")]'),
        (By.CSS_SELECTOR, 'button[id*="hangup"]'),
    ], timeout=10, label="Leave")

    if left:
        log("Left meeting successfully.")
    else:
        log("Could not find Leave button - closing browser.")

    time.sleep(2)

except KeyboardInterrupt:
    log("Interrupted - leaving meeting.")
except Exception as e:
    log("FATAL ERROR: " + str(e))
    screenshot(driver, "fatal_error")
    sys.exit(1)
finally:
    try:
        driver.quit()
    except Exception:
        pass
    # Clean up the temporary Chrome profile directory
    try:
        shutil.rmtree(_profile_dir, ignore_errors=True)
    except Exception:
        pass
    log("Browser closed. Done.")
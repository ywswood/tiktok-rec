import requests
import json
import base64
import time
import datetime

# Configuration
# Read API_URL from app.js or use the one we saw in previous steps
API_URL = 'https://script.google.com/macros/s/AKfycbwtKHqOYcbBRqe-fEqUqiag_oFjSlnkD8K5If-pIq5UjE386qQf47Rkdfe1LTmQdjhH9Q/exec'

# Mock Data
SESSION_ID = f"test_debug_{datetime.datetime.now().strftime('%y%m%d_%H%M%S')}"
CHUNK_FILENAME = f"{SESSION_ID}_chunk00.webm"

# Create a tiny dummy webm file (or just random bytes masked as webm for testing if strict validation isn't on)
# Ideally we'd use a real file, but for connectivity test random bytes might pass the Blob check, 
# though transcription will fail. 
# Let's try to mimic the structure if possible, or just send a small base64 string.
DUMMY_AUDIO_DATA = base64.b64encode(b'dummy_audio_content').decode('utf-8')

def log(msg):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}")

def test_upload_chunk():
    log(f"Testing upload_chunk for {CHUNK_FILENAME}...")
    payload = {
        'action': 'upload_chunk',
        'fileName': CHUNK_FILENAME,
        'audioData': DUMMY_AUDIO_DATA
    }
    
    try:
        response = requests.post(API_URL, json=payload)
        log(f"Status Code: {response.status_code}")
        log(f"Response: {response.text}")
        return True
    except Exception as e:
        log(f"Error: {e}")
        return False

def test_generate_script():
    log(f"Testing generate_script for {SESSION_ID}...")
    payload = {
        'action': 'generate_script',
        'sessionId': SESSION_ID
    }
    
    try:
        response = requests.post(API_URL, json=payload)
        log(f"Status Code: {response.status_code}")
        log(f"Response: {response.text}")
    except Exception as e:
        log(f"Error: {e}")

if __name__ == "__main__":
    log("=== STARTING DEBUG SIMULATION ===")
    if test_upload_chunk():
        log("Waiting 2 seconds...")
        time.sleep(2)
        test_generate_script()
    log("=== END SIMULATION ===")

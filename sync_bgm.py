import os
import requests
import json
from dotenv import load_dotenv

# ==========================================
# 1. Configuration
# ==========================================
# tiktok-auto の .env から認証情報を取得
load_dotenv()

CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
REFRESH_TOKEN = os.getenv("GOOGLE_REFRESH_TOKEN")

BGM_CONFIG = {
    "energy": os.getenv("BGM_ENERGY_ID"),
    "chill": os.getenv("BGM_CHILL_ID")
}

LOCAL_BGM_DIR = "C:\\data\\dev\\tiktok-rec\\bgm"

def get_access_token():
    """OAuth2 リフレッシュトークンを使用してアクセストークンを取得"""
    url = "https://oauth2.googleapis.com/token"
    data = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": REFRESH_TOKEN,
        "grant_type": "refresh_token"
    }
    try:
        res = requests.post(url, data=data, timeout=30)
        token_data = res.json()
        if "access_token" in token_data:
            return token_data["access_token"]
        else:
            print(f"Token Error: {token_data}")
            return None
    except Exception as e:
        print(f"Failed to refresh token: {e}")
        return None

def download_file(file_id, dest_path, access_token):
    """Google Drive からファイルをダウンロード"""
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        res = requests.get(url, headers=headers, stream=True, timeout=60)
        if res.status_code == 200:
            with open(dest_path, "wb") as f:
                for chunk in res.iter_content(chunk_size=8192):
                    f.write(chunk)
            return True
        else:
            print(f"Download Error {res.status_code}: {res.text}")
    except Exception as e:
        print(f"Download Exception: {e}")
    return False

def list_files_in_folder(folder_id, access_token):
    """フォルダ内のファイル一覧を取得"""
    url = f"https://www.googleapis.com/drive/v3/files?q='{folder_id}'+in+parents+and+trashed=false"
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        res = requests.get(url, headers=headers, timeout=30)
        if res.status_code == 200:
            return res.json().get("files", [])
        else:
            print(f"List Error {res.status_code}: {res.text}")
    except Exception as e:
        print(f"List Exception: {e}")
    return []

def sync_all():
    token = get_access_token()
    if not token:
        print("Failed to obtain OAuth2 access token.")
        return

    for genre, folder_id in BGM_CONFIG.items():
        genre_dir = os.path.join(LOCAL_BGM_DIR, genre)
        os.makedirs(genre_dir, exist_ok=True)
        
        print(f"Syncing {genre}...")
        files = list_files_in_folder(folder_id, token)
        for f in files:
            file_name = f["name"]
            file_id = f["id"]
            dest = os.path.join(genre_dir, file_name)
            
            if not os.path.exists(dest):
                print(f"  Downloading {file_name}...")
                if download_file(file_id, dest, token):
                    print(f"  Done.")
                else:
                    print(f"  Failed.")
            else:
                print(f"  {file_name} already exists.")

if __name__ == "__main__":
    sync_all()

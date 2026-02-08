from PIL import Image
import sys
import os

def convert_to_tiktok_vertical(input_path, target_size=(1080, 1920)):
    if not os.path.isfile(input_path):
        print(f"エラー: ファイルが見つかりません {input_path}")
        sys.exit(1)
    
    img = Image.open(input_path).convert('RGB')
    orig_w, orig_h = img.size
    target_w, target_h = target_size
    target_ratio = target_w / target_h
    orig_ratio = orig_w / orig_h

    if orig_ratio > target_ratio:
        new_w = target_w
        new_h = int(target_w / orig_ratio)
    else:
        new_h = target_h
        new_w = int(target_h * orig_ratio)

    resized = img.resize((new_w, new_h), Image.LANCZOS)
    background = Image.new('RGB', target_size, (0,0,0))
    background.paste(resized, ((target_w - new_w)//2, (target_h - new_h)//2))
    background.save(input_path, quality=95)
    print(f'変換完了: {input_path} ({target_w}x{target_h})')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("使い方: python script.py <画像パス>")
        sys.exit(1)
    convert_to_tiktok_vertical(sys.argv[1])

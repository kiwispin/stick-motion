
import os

try:
    with open('index.html', 'r', encoding='utf-8') as f:
        lines = f.readlines()

    # Debug: print what we think are the split points
    print(f"Line 167: {lines[167].strip()}")
    print(f"Line 170: {lines[170].strip()}")

    start_idx = 169 # After body tag (167, 168)
    
    # Dynamic end search
    end_idx = -1
    for i, line in enumerate(lines):
        if '<script>' in line:
            end_idx = i
            print(f"Found script at {i}")
            break
            
    if end_idx == -1:
        print("Fatal: Could not find script tag.")
        exit(1)

    with open('_temp_body.html', 'r', encoding='utf-8') as f:
        new_body = f.read()

    # The head part includes lines 0 to 168 (169 lines).
    # so lines[:169]
    head_part = "".join(lines[:start_idx])
    script_part = "".join(lines[end_idx:])
    
    new_content = head_part + "\n" + new_body + "\n" + script_part
    
    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(new_content)
        
    print("Success: index.html updated.")

except Exception as e:
    print(f"Error: {e}")

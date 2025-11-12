#!/bin/bash

# Helper script to properly encode passwords with special characters in PostgreSQL URLs

echo "=========================================="
echo "PostgreSQL URL Password Encoding Helper"
echo "=========================================="
echo ""
echo "If your password contains special characters, they need to be URL-encoded."
echo ""
echo "Common special characters and their encodings:"
echo "  \$  →  %24"
echo "  =   →  %3D"
echo "  @   →  %40"
echo "  #   →  %23"
echo "  &   →  %26"
echo "  +   →  %2B"
echo "  /   →  %2F"
echo "  ?   →  %3F"
echo "  :   →  %3A"
echo "  ;   →  %3B"
echo "  ,   →  %2C"
echo "  '   →  %27"
echo "  \"   →  %22"
echo "  [   →  %5B"
echo "  ]   →  %5D"
echo "  {   →  %7B"
echo "  }   →  %7D"
echo "  |   →  %7C"
echo "  \\   →  %5C"
echo ""
echo "Example:"
echo "  Password: ThkpB\$X=bmAoBzD0"
echo "  Encoded:  ThkpB%24X%3DbmAoBzD0"
echo ""
echo "Full URL format:"
echo "  postgresql://postgres:ENCODED_PASSWORD@host:5432/dbname"
echo ""
echo "=========================================="
echo "Quick Encode (paste your password):"
echo "=========================================="
echo ""

read -sp "Enter password to encode: " PASSWORD
echo ""

# URL encode the password
ENCODED=$(python3 -c "
import urllib.parse
password = '$PASSWORD'
encoded = urllib.parse.quote(password, safe='')
print(encoded)
")

echo "Encoded password: $ENCODED"
echo ""
echo "Use this in your .env.local:"
echo "  TARGET_DATABASE_URL=postgresql://postgres:$ENCODED@10.107.240.2:5432/reya"
echo ""





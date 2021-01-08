

# Read recommended R package version from package.json
VERSION=$(cat package.json | jq -r .rPackageInfo.recommended)

URL=https://api.github.com/repos/ManuelHentschel/vscDebugger/releases/tags/v$VERSION

echo $URL

# Read info about release assets from GitHub API
ASSETS=$(curl $URL | jq -r .assets)

# Abort, if no release/assets available
if [ "$ASSETS" == "null" ]; then
    echo "No vscDebugger release with version $VERSION found!"
    exit 1
fi

# Loop over assets and download them if they are vscDebugger binaries
i=0
NAME=$(echo $ASSETS | jq -r .[$i].name)

while [ "$NAME" != "null" ]
do
    echo "$NAME"
    if [[ "$NAME" =~ "vscDebugger" ]]; then
        URL=$(echo $ASSETS | jq -r .[$i].browser_download_url)
        echo "$URL"
        wget -P assets "$URL"
    fi

    i=$(( $i + 1 ))
    NAME=$(echo $ASSETS | jq -r .[$i].name)
done


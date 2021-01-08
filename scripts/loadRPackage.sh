


VERSION=$(cat package.json | jq -r .rPackageInfo.recommended)

URL=https://api.github.com/repos/ManuelHentschel/vscDebugger/releases/tags/v$VERSION

echo $URL

ASSETS=$(curl $URL | jq -r .assets)

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


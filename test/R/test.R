
library(vscDebugger)

f <- function(){
    print(1)
    print(2)
    print('done')
}

listen <- vscDebugger::.vsc.listenForDAP



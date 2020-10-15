
library(vscDebugger)

f <- function(){
    print(1)
    print(2)
    print('done')
}

listen <- vscDebugger::.vsc.listenForDAP

l <- list(
    a=1,
    b=2,
    c=3
)

x <- 99

s <- 'asdf'


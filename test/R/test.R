
# library(vscDebugger)

options(vsc.groupAttributes = TRUE)

options(vsc.showInternalFrames = TRUE)

options(vsc.showAttributes = FALSE)
options(vsc.showCustomAttributes = FALSE)


options(vsc.convertFactorEntries = TRUE)

tempWait0 <- 2
# tempWait1 <- 0.1

f <- function(){
    print(1)
    cat('asdf\n', file=stderr())
    x <- 7777
    # browser()
    print(2)
    print('done')
}

# listen <- vscDebugger::.vsc.listenForDAP

l <- list(
    a=1,
    b=2,
    c=3
)

x <- 99

s <- 'asdf'

g <- function(){
    f()
}

g()

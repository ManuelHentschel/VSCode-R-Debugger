
tryCatch(
    detach('package:vscDebugger', unload = TRUE),
    error = function(e) {}
)
rm(list=ls(all.names=TRUE))

library(vscDebugger)

options(error = traceback)

# trace(vscDebugger:::forceChildren, tracer=browser)

main <- function(){
    stack <- vscDebugger:::stackTraceRequest(list(), list(), list())
    scopes <- vscDebugger:::scopesRequest(list(), list(frameId=0), list())
    vars <- vscDebugger:::variablesRequest(list(), list(variablesReference=12), list())
    list(
        stack,
        scopes,
        vars
    )
}

ret <- main()



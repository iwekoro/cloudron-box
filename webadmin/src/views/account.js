'use strict';

angular.module('Application').controller('AccountController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    $scope.user = Client.getUserInfo();
    $scope.config = Client.getConfig();

    $scope.activeClients = [];
    $scope.tokenInUse = null;

    $scope.passwordchange = {
        busy: false,
        error: {},
        password: '',
        newPassword: '',
        newPasswordRepeat: '',

        reset: function () {
            $scope.passwordchange.error.password = null;
            $scope.passwordchange.error.newPassword = null;
            $scope.passwordchange.error.newPasswordRepeat = null;
            $scope.passwordchange.password = '';
            $scope.passwordchange.newPassword = '';
            $scope.passwordchange.newPasswordRepeat = '';

            $scope.passwordChangeForm.$setUntouched();
            $scope.passwordChangeForm.$setPristine();
        },

        show: function () {
            $scope.passwordchange.reset();
            $('#passwordChangeModal').modal('show');
        },

        submit: function () {
            $scope.passwordchange.error.password = null;
            $scope.passwordchange.error.newPassword = null;
            $scope.passwordchange.error.newPasswordRepeat = null;
            $scope.passwordchange.busy = true;

            Client.changePassword($scope.passwordchange.password, $scope.passwordchange.newPassword, function (error) {
                $scope.passwordchange.busy = false;

                if (error) {
                    if (error.statusCode === 403) {
                        $scope.passwordchange.error.password = true;
                        $scope.passwordchange.password = '';
                        $('#inputPasswordChangePassword').focus();
                        $scope.passwordChangeForm.password.$setPristine();
                    } else if (error.statusCode === 400) {
                        $scope.passwordchange.error.newPassword = error.message;
                        $scope.passwordchange.newPassword = '';
                        $scope.passwordchange.newPasswordRepeat = '';
                        $scope.passwordChangeForm.newPassword.$setPristine();
                        $scope.passwordChangeForm.newPasswordRepeat.$setPristine();
                        $('#inputPasswordChangeNewPassword').focus();
                    } else {
                        console.error('Unable to change password.', error);
                    }
                    return;
                }

                $scope.passwordchange.reset();
                $('#passwordChangeModal').modal('hide');
            });
        }
    };

    $scope.emailchange = {
        busy: false,
        error: {},
        email: '',

        reset: function () {
            $scope.emailchange.busy = false;
            $scope.emailchange.error.email = null;
            $scope.emailchange.email = '';

            $scope.emailChangeForm.$setUntouched();
            $scope.emailChangeForm.$setPristine();
        },

        show: function () {
            $scope.emailchange.reset();
            $('#emailChangeModal').modal('show');
        },

        submit: function () {
            $scope.emailchange.error.email = null;
            $scope.emailchange.busy = true;

            var user = {
                id: $scope.user.id,
                email: $scope.emailchange.email
            };

            Client.updateUser(user, function (error) {
                $scope.emailchange.busy = false;

                if (error) {
                    console.error('Unable to change email.', error);
                    return;
                }

                // update user info in the background
                Client.refreshUserInfo();

                $scope.emailchange.reset();
                $('#emailChangeModal').modal('hide');
            });
        }
    };

    $scope.removeAccessTokens = function (client) {
        client.busy = true;

        Client.delTokensByClientId(client.id, function (error) {
            if (error) console.error(error);

            client.busy = false;

            // update the list
            Client.getOAuthClients(function (error, activeClients) {
                if (error) return console.error(error);

                $scope.activeClients = activeClients;
            });
        });
    };

    Client.onReady(function () {
        $scope.tokenInUse = Client._token;

        Client.getOAuthClients(function (error, activeClients) {
            if (error) return console.error(error);

            $scope.activeClients = activeClients;
        });
    });

    // setup all the dialog focus handling
    ['passwordChangeModal', 'emailChangeModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });
}]);
